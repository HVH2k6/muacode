const mongoose = require('mongoose');

const SourceCodeSchema = new mongoose.Schema({
  title: { type: String, required: true },
  imageUrl: String,
  description: String,
  driveLink: { type: String, required: true }, // link chứa toàn bộ code
  priceVND: { type: Number, required: true, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('SourceCode', SourceCodeSchema);
