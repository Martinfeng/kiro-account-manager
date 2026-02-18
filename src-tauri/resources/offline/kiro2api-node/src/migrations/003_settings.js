import fs from 'fs';
import path from 'path';

/**
 * 数据迁移脚本：从 settings.json 迁移到 SQLite 数据库
 */
export async function migrateSettings(dbManager, dataDir) {
  const settingsPath = path.join(dataDir, 'settings.json');

  // 检查 JSON 文件是否存在
  if (!fs.existsSync(settingsPath)) {
    console.log('⚠ 未找到 settings.json，跳过设置迁移');
    return { migrated: 0, skipped: true };
  }

  try {
    // 读取 JSON 设置数据
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    console.log('📦 开始迁移系统设置...');

    // 使用事务迁移设置
    const migrate = dbManager.db.transaction(() => {
      // 迁移 adminKey
      if (settings.adminKey) {
        const stmt = dbManager.db.prepare(`
          INSERT INTO settings (id, admin_key)
          VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET admin_key = excluded.admin_key
        `);
        stmt.run(settings.adminKey);
      }

      // 迁移 apiKeys
      if (settings.apiKeys && Array.isArray(settings.apiKeys)) {
        const stmt = dbManager.db.prepare('INSERT OR IGNORE INTO api_keys (key) VALUES (?)');
        for (const key of settings.apiKeys) {
          stmt.run(key);
        }
      }
    });

    migrate();

    // 备份原 JSON 文件
    const backupPath = path.join(dataDir, `settings.json.backup.${Date.now()}`);
    fs.copyFileSync(settingsPath, backupPath);
    console.log(`✓ 已备份原文件到: ${backupPath}`);

    // 删除原 JSON 文件，防止重复迁移
    fs.unlinkSync(settingsPath);
    console.log(`✓ 已删除原 JSON 文件，防止重复迁移`);

    console.log('✓ 成功迁移系统设置到数据库');

    return { migrated: 1, skipped: false };
  } catch (error) {
    console.error('❌ 设置迁移失败:', error.message);
    return { migrated: 0, skipped: false, error: error.message };
  }
}
