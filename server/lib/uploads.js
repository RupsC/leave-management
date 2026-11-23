'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { config } = require('./env');
const { ApiError, badRequest, notFound } = require('./errors');

/**
 * Supporting documents are stored on disk in UPLOAD_DIR, which is deliberately
 * outside the public/ web root. Nothing is ever served as a static file: the
 * only way to read one is the download route, which checks the requesting
 * user's rights first.
 */

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buffer, bytes) {
  if (!buffer || buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[i] !== bytes[i]) return false;
  }
  return true;
}

/** Identify the real file type from its content, not from its name. */
function detectFileType(buffer) {
  if (startsWith(buffer, PDF_MAGIC)) return { mime: 'application/pdf', ext: '.pdf' };
  if (startsWith(buffer, PNG_MAGIC)) return { mime: 'image/png', ext: '.png' };
  if (startsWith(buffer, JPEG_MAGIC)) return { mime: 'image/jpeg', ext: '.jpg' };
  return null;
}

function ensureUploadDir() {
  fs.mkdirSync(config.uploadDir, { recursive: true, mode: 0o700 });
}

const maxBytes = () => config.maxUploadMb * 1024 * 1024;

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxBytes(), files: 1, fields: 20 },
  fileFilter(req, file, cb) {
    if (!['application/pdf', 'image/png', 'image/jpeg'].includes(file.mimetype)) {
      return cb(badRequest('Supporting documents must be a PDF, PNG or JPG file.'));
    }
    cb(null, true);
  },
}).single('attachment');

/** Express middleware wrapper that turns upload problems into clean JSON errors. */
function handleUpload(req, res, next) {
  uploadMiddleware(req, res, (err) => {
    if (!err) return next();
    if (err instanceof ApiError) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(
        new ApiError(
          413,
          'file_too_large',
          `That file is too large. The maximum size is ${config.maxUploadMb} MB.`,
        ),
      );
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(badRequest('Only one supporting document can be uploaded per request.'));
    }
    return next(badRequest('The upload could not be read. Please try again.'));
  });
}

/** Store an uploaded file safely. Returns the metadata to save in the database. */
function saveAttachment(file) {
  if (!file || !file.buffer || file.buffer.length === 0) return null;
  if (file.buffer.length > maxBytes()) {
    throw new ApiError(
      413,
      'file_too_large',
      `That file is too large. The maximum size is ${config.maxUploadMb} MB.`,
    );
  }
  const type = detectFileType(file.buffer);
  if (!type) throw badRequest('That file is not a real PDF, PNG or JPG document.');
  ensureUploadDir();
  const storedName = `${crypto.randomBytes(16).toString('hex')}${type.ext}`;
  fs.writeFileSync(path.join(config.uploadDir, storedName), file.buffer, { mode: 0o600 });

  const cleanName =
    path
      .basename(file.originalname || 'document')
      .replace(/[^\w.\- ()]/g, '_')
      .slice(0, 120) || 'document';

  return {
    originalName: cleanName,
    storedName,
    mimeType: type.mime,
    sizeBytes: file.buffer.length,
  };
}

function storedPath(storedName) {
  // Never trust a stored value as a path: reduce it to a bare file name.
  const safe = path.basename(String(storedName));
  if (!/^[a-f0-9]{32}\.(pdf|png|jpg)$/.test(safe)) {
    throw notFound('That document is not available.');
  }
  const full = path.join(config.uploadDir, safe);
  if (!fs.existsSync(full)) throw notFound('That document is no longer stored on the server.');
  return full;
}

/** Remove a stored file (used if saving the request fails after the upload). */
function discardAttachment(storedName) {
  try {
    const full = path.join(config.uploadDir, path.basename(String(storedName)));
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch {
    /* best effort */
  }
}

module.exports = {
  detectFileType,
  handleUpload,
  saveAttachment,
  storedPath,
  discardAttachment,
  ensureUploadDir,
};
