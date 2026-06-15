const express = require('express');
const cors = require('cors');
require('./db');

const authRoutes = require('./routes/auth');
const headphonesModule = require('./routes/headphones');
const chargingCasesRoutes = require('./routes/charging_cases');
const borrowBatchesRoutes = require('./routes/borrow_batches');
const operationsRoutes = require('./routes/operations');
const alertsModule = require('./routes/alerts');
const statsRoutes = require('./routes/stats');

const app = express();
const PORT = 8878;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({
    name: '展厅讲解耳机管理系统 API',
    version: '1.0.0',
    port: PORT,
    endpoints: {
      auth: {
        login: 'POST /api/auth/login',
        register: 'POST /api/auth/register (admin)',
        me: 'GET /api/auth/me',
        users: 'GET /api/auth/users (admin)',
        update_user: 'PUT /api/auth/users/:id (admin)',
        delete_user: 'DELETE /api/auth/users/:id (admin)'
      },
      headphones: {
        list: 'GET /api/headphones?content_version&cabinet_position&responsible_person&status&start_date&end_date&min_battery&max_battery',
        get: 'GET /api/headphones/:id',
        create: 'POST /api/headphones (admin)',
        update: 'PUT /api/headphones/:id (admin, 版本变更自动转「待复核」)',
        change_status: 'PUT /api/headphones/:id/status (发放员仅能切换停用观察)',
        maintenance: 'POST /api/headphones/:id/maintenance (admin)',
        review: 'POST /api/headphones/:id/review (admin, 独立复核版本变更/需复核的耳机)',
        delete: 'DELETE /api/headphones/:id (admin)'
      },
      charging_cases: {
        list: 'GET /api/charging-cases',
        get: 'GET /api/charging-cases/:id',
        create: 'POST /api/charging-cases (admin)',
        update: 'PUT /api/charging-cases/:id (admin)',
        add_headphone: 'POST /api/charging-cases/:id/headphones',
        remove_headphone: 'DELETE /api/charging-cases/:id/headphones/:headphone_id',
        delete: 'DELETE /api/charging-cases/:id (admin)'
      },
      borrow_batches: {
        list: 'GET /api/borrow-batches?is_active&start_date&end_date',
        get: 'GET /api/borrow-batches/:id',
        create: 'POST /api/borrow-batches',
        add_headphones: 'POST /api/borrow-batches/:id/add-headphones',
        close: 'POST /api/borrow-batches/:id/close',
        delete: 'DELETE /api/borrow-batches/:id (admin)'
      },
      operations: {
        active_records: 'GET /api/operations/active',
        return: 'POST /api/operations/return/:record_id',
        review: 'POST /api/operations/review/:record_id (admin)',
        check_recycle: 'POST /api/operations/check-recycle'
      },
      alerts: {
        list: 'GET /api/alerts?alert_type&severity&is_resolved',
        detect: 'GET /api/alerts/detect',
        version_mixing: 'GET /api/alerts/version-mixing',
        low_battery_backlog: 'GET /api/alerts/low-battery-backlog',
        unreturned_overdue: 'GET /api/alerts/unreturned-overdue',
        consecutive_abnormal: 'GET /api/alerts/consecutive-abnormal',
        resolve: 'PUT /api/alerts/:id/resolve (admin)'
      },
      stats: {
        dashboard: 'GET /api/stats/dashboard',
        low_battery_list: 'GET /api/stats/low-battery-list?threshold&cabinet_position&responsible_person',
        version_stats: 'GET /api/stats/version-stats',
        turnover_distribution: 'GET /api/stats/turnover-distribution?start_date&end_date'
      }
    },
    default_accounts: {
      admin: 'admin / admin123',
      issuer: 'issuer01 / issuer123'
    }
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/headphones', headphonesModule.router);
app.use('/api/charging-cases', chargingCasesRoutes);
app.use('/api/borrow-batches', borrowBatchesRoutes);
app.use('/api/operations', operationsRoutes);
app.use('/api/alerts', alertsModule.router);
app.use('/api/stats', statsRoutes);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: '服务器内部错误',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ==============================================
  展厅讲解耳机管理系统 API 服务已启动
  端口: ${PORT}
  访问地址: http://localhost:${PORT}
  ==============================================
  默认账号:
    管理员: admin / admin123
    发放员: issuer01 / issuer123
  ==============================================
  `);
});
