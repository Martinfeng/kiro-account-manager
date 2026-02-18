import fs from 'fs';
import path from 'path';

/**
 * 数据迁移脚本：从 accounts.json 迁移到 SQLite 数据库
 */
export async function migrateAccounts(dbManager, dataDir) {
  const accountsPath = path.join(dataDir, 'accounts.json');

  // 检查 JSON 文件是否存在
  if (!fs.existsSync(accountsPath)) {
    console.log('⚠ 未找到 accounts.json，跳过账号迁移');
    return { migrated: 0, skipped: true };
  }

  try {
    // 读取 JSON 账号数据
    const content = fs.readFileSync(accountsPath, 'utf-8');
    const accounts = JSON.parse(content);

    if (!Array.isArray(accounts) || accounts.length === 0) {
      console.log('⚠ accounts.json 为空，跳过迁移');
      return { migrated: 0, skipped: true };
    }

    console.log(`📦 开始迁移 ${accounts.length} 个账号...`);

    // 批量插入（使用事务提升性能）
    const insertStmt = dbManager.db.prepare(`
      INSERT INTO accounts (
        id, name, credentials, status, request_count, error_count,
        created_at, last_used_at, usage
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = dbManager.db.transaction((accounts) => {
      for (const acc of accounts) {
        insertStmt.run(
          acc.id,
          acc.name || '未命名账号',
          JSON.stringify(acc.credentials || {}),
          acc.status || 'active',
          acc.requestCount || 0,
          acc.errorCount || 0,
          acc.createdAt || new Date().toISOString(),
          acc.lastUsedAt || null,
          acc.usage ? JSON.stringify(acc.usage) : null
        );
      }
    });

    insertMany(accounts);

    // 备份原 JSON 文件
    const backupPath = path.join(dataDir, `accounts.json.backup.${Date.now()}`);
    fs.copyFileSync(accountsPath, backupPath);
    console.log(`✓ 已备份原文件到: ${backupPath}`);

    // 删除原 JSON 文件，防止重复迁移
    fs.unlinkSync(accountsPath);
    console.log(`✓ 已删除原 JSON 文件，防止重复迁移`);

    console.log(`✓ 成功迁移 ${accounts.length} 个账号到数据库`);

    return { migrated: accounts.length, skipped: false };
  } catch (error) {
    console.error('❌ 账号迁移失败:', error.message);
    return { migrated: 0, skipped: false, error: error.message };
  }
}
