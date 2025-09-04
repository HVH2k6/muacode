const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const morgan = require('morgan');
const methodOverride = require('method-override');
const basicAuth = require('express-basic-auth');
const { PayOS } = require('@payos/node');
const expressLayouts = require('express-ejs-layouts');
const crypto = require('crypto');

dotenv.config();

const app = express();

// ===== Mongo =====
mongoose
  .connect(process.env.MONGO_URI, { dbName: 'code_shop' })
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error(err));

// ===== Models =====
const SourceCode = require('./models/SourceCode');
const Order = require('./models/Order');

// ===== payOS client =====
const payos = new PayOS({
  clientId: process.env.PAYOS_CLIENT_ID,
  apiKey: process.env.PAYOS_API_KEY,
  checksumKey: process.env.PAYOS_CHECKSUM_KEY,
});

// ===== View & static =====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(expressLayouts);
app.set('layout', 'partials/layout');

// ===== Middlewares =====
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));

// ===== Helpers =====
const adminAuth = basicAuth({
  users: {
    [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASSWORD || 'admin123',
  },
  challenge: true,
});
const money = (n) => new Intl.NumberFormat('vi-VN').format(n);

// ===== Public pages =====
app.get('/', async (req, res) => {
  const codes = await SourceCode.find().sort({ createdAt: -1 });
  res.render('home', { codes, money });
});

app.get('/code/:id', async (req, res) => {
  const code = await SourceCode.findById(req.params.id);
  if (!code) return res.status(404).send('Not found');
  res.render('code_show', { code, money });
});

// Tạo đơn: name, email, chọn code => redirect payOS
app.get('/order/new/:codeId', async (req, res) => {
  const code = await SourceCode.findById(req.params.codeId);
  if (!code) return res.status(404).send('Not found');
  res.render('order_new', { code, money });
});

app.post('/order', async (req, res) => {
  try {
    const { name, email, codeId } = req.body;
    const code = await SourceCode.findById(codeId);
    if (!code) return res.status(404).send('Code not found');

    // orderCode: số nguyên duy nhất (payOS yêu cầu integer)
    const orderCode = Date.now();

    const order = await Order.create({
      buyerName: name,
      buyerEmail: email,
      code: code._id,
      amount: code.priceVND,
      orderCode,
      status: 'PENDING',
    });

    // Chữ ký gắn vào returnUrl (xác nhận đơn đã thanh toán khi không dùng webhook)
    const statusText = 'PAID';
    const sig = crypto
      .createHmac('sha256', process.env.PAYOS_CHECKSUM_KEY)
      .update(`${orderCode}:${statusText}`)
      .digest('hex');

    const returnUrl = `${process.env.BASE_URL}/order/${order._id}/success?orderCode=${orderCode}&status=${statusText}&sig=${sig}`;
    const cancelUrl = `${process.env.BASE_URL}/order/${order._id}/cancel`;

    // Tạo link thanh toán
    const paymentLink = await payos.paymentRequests.create({
      orderCode,
      amount: code.priceVND,
      description: `Thanh toán đơn mua code`,
      returnUrl,
      cancelUrl,
      buyerName: name,
      buyerEmail: email,
      items: [{ name: code.title, quantity: 1, price: code.priceVND }],
    });

    // Lưu paymentLinkId + checkoutUrl
    order.paymentLinkId = paymentLink.paymentLinkId || paymentLink.data?.paymentLinkId;
    order.checkoutUrl = paymentLink.checkoutUrl || paymentLink.data?.checkoutUrl;
    await order.save();

    res.redirect(order.checkoutUrl);
  } catch (err) {
    console.error(err);
    res.status(500).send('Không tạo được đơn / link thanh toán.');
  }
});

// Return URL (không dùng webhook, xác nhận bằng sig ở query)
app.get('/order/:id/success', async (req, res) => {
  const order = await Order.findById(req.params.id).populate('code');
  if (!order) return res.status(404).send('Not found');

  const { status, orderCode, sig } = req.query;

  try {
    // verify sig: HMAC-SHA256(`${orderCode}:${status}`, CHECKSUM_KEY)
    const expected = crypto
      .createHmac('sha256', process.env.PAYOS_CHECKSUM_KEY)
      .update(`${order.orderCode}:${status}`)
      .digest('hex');

    if (status === 'PAID' && sig === expected) {
      order.status = 'PAID';
      order.paidAt = new Date();
      await order.save();
    }
  } catch (_) {
    // ignore verify error -> vẫn render trang, trạng thái lấy từ DB
  }

  res.render('order_status', { order, money, ok: true });
});

app.get('/order/:id/cancel', async (req, res) => {
  const order = await Order.findById(req.params.id).populate('code');
  if (!order) return res.status(404).send('Not found');
  res.render('order_status', { order, money, ok: false });
});

// API nhỏ cho client polling trạng thái
app.get('/api/order/:id', async (req, res) => {
  const order = await Order.findById(req.params.id).populate('code');
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json({ status: order.status });
});

// ===== ADMIN =====
app.get('/admin', adminAuth, (req, res) => res.redirect('/admin/codes'));

// Codes
app.get('/admin/codes', adminAuth, async (req, res) => {
  const codes = await SourceCode.find().sort({ createdAt: -1 });
  res.render('admin/codes_list', { codes, money });
});

app.get('/admin/codes/new', adminAuth, (req, res) => {
  res.render('admin/code_form', {
    code: {},
    action: '/admin/codes',
    method: 'POST',
  });
});

app.post('/admin/codes', adminAuth, async (req, res) => {
  const { title, imageUrl, description, driveLink, priceVND } = req.body;
  await SourceCode.create({
    title,
    imageUrl,
    description,
    driveLink,
    priceVND: Number(priceVND) || 0,
  });
  res.redirect('/admin/codes');
});

app.get('/admin/codes/:id/edit', adminAuth, async (req, res) => {
  const code = await SourceCode.findById(req.params.id);
  if (!code) return res.status(404).send('Not found');
  res.render('admin/code_form', {
    code,
    action: `/admin/codes/${code._id}?_method=PUT`,
    method: 'POST',
  });
});

app.put('/admin/codes/:id', adminAuth, async (req, res) => {
  const { title, imageUrl, description, driveLink, priceVND } = req.body;
  await SourceCode.findByIdAndUpdate(req.params.id, {
    title,
    imageUrl,
    description,
    driveLink,
    priceVND: Number(priceVND) || 0,
  });
  res.redirect('/admin/codes');
});

app.delete('/admin/codes/:id', adminAuth, async (req, res) => {
  await SourceCode.findByIdAndDelete(req.params.id);
  res.redirect('/admin/codes');
});

// Orders
app.get('/admin/orders', adminAuth, async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 }).populate('code');
  res.render('admin/orders_list', { orders, money });
});

app.post('/admin/orders/:id/mark-paid', adminAuth, async (req, res) => {
  await Order.findByIdAndUpdate(req.params.id, {
    status: 'PAID',
    paidAt: new Date(),
  });
  res.redirect('/admin/orders');
});

// ==== ACTIVATIONS (ADMIN) ====
// GET /admin/activations?orderCode=...
app.get('/admin/activations', adminAuth, async (req, res) => {
  const { orderCode } = req.query || {};
  const q = {};
  if (orderCode) q.orderCode = Number(orderCode);

  const orders = await Order.find(q).sort({ createdAt: -1 }).populate('code');
  res.render('admin/activations', { orders, money, orderCode: orderCode || '' });
});

// POST /admin/activations/:id/reset -> clear activation của 1 đơn
app.post('/admin/activations/:id/reset', adminAuth, async (req, res) => {
  await Order.findByIdAndUpdate(req.params.id, {
    activation: { isActivated: false, activatedAt: null, deviceId: null, ip: null }
  });
  res.redirect('back');
});

// ===== API KÍCH HOẠT CODE =====
// POST /api/activate
// Body: { orderCode: number, deviceId?: string }
app.post('/api/activate', async (req, res) => {
  try {
    const { orderCode, deviceId } = req.body || {};
    if (!orderCode) {
      return res.status(400).json({ error: 'orderCode is required' });
    }

    // Tìm đơn theo orderCode
    const order = await Order.findOne({ orderCode }).populate('code');
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Chỉ cho phép kích hoạt nếu đã thanh toán
    if (order.status !== 'PAID') {
      return res.status(400).json({ error: 'Order is not PAID' });
    }

    // Đã kích hoạt rồi => chặn
    if (order.activation?.isActivated) {
      return res.status(409).json({
        error: 'Order already activated',
        activatedAt: order.activation.activatedAt,
        deviceId: order.activation.deviceId,
      });
    }

    // Lấy IP (ưu tiên x-forwarded-for cho trường hợp reverse proxy)
    const ipHeader = req.headers['x-forwarded-for'];
    const ip = Array.isArray(ipHeader)
      ? ipHeader[0]
      : (ipHeader || req.socket?.remoteAddress || req.ip || '').toString();

    // Ghi nhận kích hoạt
    order.activation = {
      isActivated: true,
      activatedAt: new Date(),
      deviceId: deviceId || null,
      ip,
    };
    await order.save();

    return res.json({
      ok: true,
      message: 'Kích hoạt thành công',
      orderId: order._id,
      orderCode: order.orderCode,
      deviceId: order.activation.deviceId,
      activatedAt: order.activation.activatedAt,
      driveLink: order.code?.driveLink || null,
    });
  } catch (e) {
    console.error('activate error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});
// Admin reset activation (Node side)
app.post('/api/admin/reset-activation', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_ACTIVATE_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { orderCode } = req.body || {};
  if (!orderCode) return res.status(400).json({ error: 'orderCode required' });

  await Order.updateOne({ orderCode }, { $set: { activation: null } });
  res.json({ ok: true });
});
app.post('/api/validate', async (req, res) => {
  try {
    const { orderCode, deviceId } = req.body || {};
    if (!orderCode || !deviceId) {
      return res.status(400).json({ error: 'orderCode & deviceId required' });
    }

    const order = await Order.findOne({ orderCode }).populate('code');
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Phải đã thanh toán
    if (order.status !== 'PAID') {
      return res.status(400).json({ error: 'Order is not PAID' });
    }

    // Chưa kích hoạt -> không hợp lệ theo flow của bạn (bắt người dùng kích hoạt trước)
    if (!order.activation?.isActivated) {
      return res.status(403).json({ error: 'Order not activated yet' });
    }

    // Device phải khớp
    if (order.activation.deviceId && order.activation.deviceId !== deviceId) {
      return res.status(409).json({ error: 'Device mismatch' });
    }

    // (tuỳ chọn) nếu muốn kiểm soát hạn 999 ngày ở Node luôn (thay vì PHP):
    // const MAX_DAYS = 999;
    // const ageMs = Date.now() - new Date(order.activation.activatedAt).getTime();
    // if (ageMs > MAX_DAYS * 86400_000) {
    //   return res.status(403).json({ error: 'License expired' });
    // }

    // OK
    return res.json({ ok: true });
  } catch (e) {
    console.error('validate error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});
// --- Trang tổng hợp GET links ---
app.get('/links', async (req, res) => {
  const sampleCode = await SourceCode.findOne().sort({ createdAt: -1 });
  const sampleOrder = await Order.findOne().sort({ createdAt: -1 });

  const links = [
    { path: '/', label: 'Trang chủ (danh sách source code)' },
    sampleCode
      ? { path: `/code/${sampleCode._id}`, label: 'Chi tiết 1 source code (ví dụ)' }
      : { path: '/code/:id', label: 'Chi tiết 1 source code (thay :id)' },
    sampleCode
      ? { path: `/order/new/${sampleCode._id}`, label: 'Form tạo đơn mua (ví dụ)' }
      : { path: '/order/new/:codeId', label: 'Form tạo đơn mua (thay :codeId)' },
    sampleOrder
      ? { path: `/order/${sampleOrder._id}/success`, label: 'Trang success sau thanh toán (ví dụ)' }
      : { path: '/order/:id/success', label: 'Trang success sau thanh toán (thay :id)' },
    sampleOrder
      ? { path: `/order/${sampleOrder._id}/cancel`, label: 'Trang huỷ thanh toán (ví dụ)' }
      : { path: '/order/:id/cancel', label: 'Trang huỷ thanh toán (thay :id)' },
    sampleOrder
      ? { path: `/api/order/${sampleOrder._id}`, label: 'API trạng thái đơn (GET, ví dụ)' }
      : { path: '/api/order/:id', label: 'API trạng thái đơn (GET, thay :id)' },

    // ADMIN
    { path: '/admin', label: 'Admin: điều hướng' },
    { path: '/admin/codes', label: 'Admin: danh sách source code' },
    sampleCode
      ? { path: `/admin/codes/${sampleCode._id}/edit`, label: 'Admin: sửa 1 source code (ví dụ)' }
      : { path: '/admin/codes/:id/edit', label: 'Admin: sửa 1 source code (thay :id)' },
    { path: '/admin/orders', label: 'Admin: danh sách đơn hàng' },
    { path: '/admin/activations', label: 'Admin: quản lý máy kích hoạt' },

    // static
    { path: '/public/*', label: 'Static assets (Bootstrap, ảnh, css, v.v.)' }
  ];

  res.render('links', { links });
});

// ===== Start =====
const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log('Server running on http://localhost:' + port)
);
