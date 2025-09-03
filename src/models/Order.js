const mongoose = require('mongoose');
const { Schema } = mongoose;

const ActivationSchema = new Schema(
  {
    isActivated: { type: Boolean, default: false },
    activatedAt: Date,
    deviceId: String,
    ip: String
  },
  { _id: false }
);

const OrderSchema = new Schema(
  {
    buyerName: String,
    buyerEmail: String,
    code: { type: Schema.Types.ObjectId, ref: 'SourceCode', required: true },
    amount: { type: Number, required: true },
    orderCode: { type: Number, required: true, unique: true }, // integer
    status: { type: String, enum: ['PENDING', 'PAID'], default: 'PENDING' },
    paymentLinkId: String,
    checkoutUrl: String,
    reference: String,
    paidAt: Date,

    // 👇 Thêm block kích hoạt
    activation: { type: ActivationSchema, default: () => ({}) }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Order', OrderSchema);
