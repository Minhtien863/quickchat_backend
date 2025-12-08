// src/utils/jwt.js
import jwt from 'jsonwebtoken';

const ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ||
  process.env.JWT_ACCESS_TOKEN_SECRET ||
  'dev-access-secret';

const REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ||
  process.env.JWT_REFRESH_TOKEN_SECRET ||
  'dev-refresh-secret';

const DEVICE_SECRET =
  process.env.JWT_DEVICE_SECRET ||
  process.env.JWT_DEVICE_TOKEN_SECRET ||
  ACCESS_SECRET;

// Build payload chung cho tất cả token
function buildPayload(user) {
  return {
    sub: user.id,
    email: user.email,
    // tv = token_version, dùng để thu hồi phiên
    tv: user.token_version ?? user.tokenVersion ?? 0,
  };
}

// Cấp accessToken + refreshToken
export function signTokens(user) {
  const payload = buildPayload(user);

  const accessToken = jwt.sign(payload, ACCESS_SECRET, {
    // KHÔNG set expiresIn => không có exp => không tự hết hạn
    // nếu bạn muốn an toàn hơn có thể để '365d'
    // expiresIn: '365d',
  });

  const refreshToken = jwt.sign(payload, REFRESH_SECRET, {
    // tương tự, có thể để '365d' nếu muốn
    // expiresIn: '365d',
  });

  return { accessToken, refreshToken };
}

// Verify access token (bỏ qua exp để không dính TokenExpiredError)
export function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET, { ignoreExpiration: true });
}

// Token cho thiết bị tin cậy (2FA)
export function signDeviceToken(userId) {
  return jwt.sign({ sub: userId }, DEVICE_SECRET, {
    // cho sống lâu, hoặc để trống expiresIn cũng được
    // expiresIn: '365d',
  });
}

export function verifyDeviceToken(token) {
  return jwt.verify(token, DEVICE_SECRET, { ignoreExpiration: true });
}
