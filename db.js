const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'database.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'issuer')),
      real_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS headphones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      serial_no TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT '待发出' CHECK (status IN (
        '待发出', '使用中', '待回收核对', '待充电', '待复核', '恢复可用', '停用观察'
      )),
      content_version TEXT,
      cabinet_position TEXT,
      responsible_person TEXT,
      maintenance_cycle_days INTEGER DEFAULT 30,
      last_maintenance_date DATE,
      battery_level INTEGER,
      needs_review INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS charging_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_no TEXT UNIQUE NOT NULL,
      capacity INTEGER NOT NULL,
      current_count INTEGER DEFAULT 0,
      location TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS case_headphones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL,
      headphone_id INTEGER NOT NULL,
      placed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      removed_at DATETIME,
      FOREIGN KEY (case_id) REFERENCES charging_cases(id),
      FOREIGN KEY (headphone_id) REFERENCES headphones(id)
    );

    CREATE TABLE IF NOT EXISTS borrow_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_no TEXT UNIQUE NOT NULL,
      issuer_id INTEGER NOT NULL,
      purpose TEXT,
      expected_return_date DATE,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (issuer_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS borrow_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      headphone_id INTEGER NOT NULL,
      batch_id INTEGER NOT NULL,
      issued_by INTEGER NOT NULL,
      issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      returned_at DATETIME,
      returned_by INTEGER,
      audition_result TEXT,
      battery_level_return INTEGER,
      earpad_condition TEXT,
      content_issue TEXT,
      review_remark TEXT,
      reviewed_by INTEGER,
      reviewed_at DATETIME,
      content_version_issued TEXT,
      content_version_return TEXT,
      FOREIGN KEY (headphone_id) REFERENCES headphones(id),
      FOREIGN KEY (batch_id) REFERENCES borrow_batches(id),
      FOREIGN KEY (issued_by) REFERENCES users(id),
      FOREIGN KEY (returned_by) REFERENCES users(id),
      FOREIGN KEY (reviewed_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS maintenance_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      headphone_id INTEGER NOT NULL,
      maintained_by INTEGER,
      maintenance_date DATE,
      notes TEXT,
      FOREIGN KEY (headphone_id) REFERENCES headphones(id),
      FOREIGN KEY (maintained_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
      headphone_id INTEGER,
      batch_id INTEGER,
      user_id INTEGER,
      message TEXT NOT NULL,
      details TEXT,
      is_resolved INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      FOREIGN KEY (headphone_id) REFERENCES headphones(id),
      FOREIGN KEY (batch_id) REFERENCES borrow_batches(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      headphone_id INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT,
      changed_by INTEGER,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      remark TEXT,
      FOREIGN KEY (headphone_id) REFERENCES headphones(id),
      FOREIGN KEY (changed_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS collection_followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      collected_by INTEGER NOT NULL,
      collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      communication_method TEXT NOT NULL DEFAULT '电话',
      remark TEXT,
      expected_return_date DATE,
      FOREIGN KEY (batch_id) REFERENCES borrow_batches(id),
      FOREIGN KEY (collected_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_headphones_status ON headphones(status);
    CREATE INDEX IF NOT EXISTS idx_headphones_version ON headphones(content_version);
    CREATE INDEX IF NOT EXISTS idx_headphones_cabinet ON headphones(cabinet_position);
    CREATE INDEX IF NOT EXISTS idx_headphones_owner ON headphones(responsible_person);
    CREATE INDEX IF NOT EXISTS idx_records_headphone ON borrow_records(headphone_id);
    CREATE INDEX IF NOT EXISTS idx_records_batch ON borrow_records(batch_id);
    CREATE INDEX IF NOT EXISTS idx_records_issued ON borrow_records(issued_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(alert_type);
    CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(is_resolved);
    CREATE INDEX IF NOT EXISTS idx_followups_batch ON collection_followups(batch_id);
    CREATE INDEX IF NOT EXISTS idx_followups_collected_at ON collection_followups(collected_at);
    CREATE INDEX IF NOT EXISTS idx_followups_collector ON collection_followups(collected_by);
  `);

  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    const salt = bcrypt.genSaltSync(10);
    const adminPwd = bcrypt.hashSync('admin123', salt);
    const issuerPwd = bcrypt.hashSync('issuer123', salt);

    const insertUser = db.prepare(`
      INSERT INTO users (username, password, role, real_name) VALUES (?, ?, ?, ?)
    `);

    insertUser.run('admin', adminPwd, 'admin', '系统管理员');
    insertUser.run('issuer01', issuerPwd, 'issuer', '发放员小王');
    insertUser.run('issuer02', issuerPwd, 'issuer', '发放员小李');

    const insertCase = db.prepare(`
      INSERT INTO charging_cases (case_no, capacity, location) VALUES (?, ?, ?)
    `);
    insertCase.run('C-001', 20, '展厅A柜');
    insertCase.run('C-002', 15, '展厅B柜');
    insertCase.run('C-003', 10, '库房');

    const insertHp = db.prepare(`
      INSERT INTO headphones (serial_no, status, content_version, cabinet_position, responsible_person, maintenance_cycle_days, battery_level)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const sampleVersions = ['v1.2.0', 'v1.2.0', 'v1.2.1', 'v1.3.0', 'v1.2.0', 'v1.3.0', 'v1.3.0', 'v1.2.1'];
    const sampleCabinets = ['A-01', 'A-02', 'A-03', 'B-01', 'B-02', 'B-03', 'C-01', 'C-02'];
    const sampleOwners = ['张三', '李四', '王五', '赵六', '张三', '李四', '王五', '赵六'];
    for (let i = 1; i <= 8; i++) {
      insertHp.run(
        `HP-${String(i).padStart(4, '0')}`,
        '待发出',
        sampleVersions[i - 1],
        sampleCabinets[i - 1],
        sampleOwners[i - 1],
        30,
        80 + i
      );
    }
  }
}

initDatabase();

module.exports = db;
