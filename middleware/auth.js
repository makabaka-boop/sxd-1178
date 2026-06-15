const jwt = require('jsonwebtoken');

const JWT_SECRET = 'sxd-1178-exhibition-headphone-system-jwt-secret-key-2026';

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未提供有效的认证令牌' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: '认证令牌已过期' });
    }
    return res.status(401).json({ error: '无效的认证令牌' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

function issuerMiddleware(req, res, next) {
  if (!['admin', 'issuer'].includes(req.user.role)) {
    return res.status(403).json({ error: '需要发放人员或管理员权限' });
  }
  next();
}

function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      real_name: user.real_name
    },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

module.exports = {
  authMiddleware,
  adminMiddleware,
  issuerMiddleware,
  generateToken,
  JWT_SECRET
};
