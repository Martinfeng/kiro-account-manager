import fs from 'fs';
import path from 'path';

/**
 * 数据迁移脚本：从 JSON 文件迁移到 SQLite 数据库
 */
export async function migrateFromJson(dbManager, dataDir) {
  const logsPath = path.join(dataDir, 'request_logs.json');
  
  // 检查 JSON 文件是否存在
  if (!fs.existsSync(logsPath)) {
    console.log('⚠ 未找到 request_logs.json，跳过数据迁移');
    return { migrated: 0, skipped: true };
  }

  try {
    // 读取 JSON 日志
    const content = fs.readFileSync(logsPath, 'utf-8');
    const logs = JSON.parse(content);

    if (!Array.isArray(logs) || logs.length === 0) {
      console.log('⚠ request_logs.json 为空，跳过迁移');
      return { migrated: 0, skipped: true };
    }

    console.log(`📦 开始迁移 ${logs.length} 条日志记录...`);

    // 批量插入（使用事务提升性能）
    const insertStmt = dbManager.db.prepare(`
      INSERT INTO request_logs (
        timestamp, account_id, account_name, model, 
        input_tokens, output_tokens, duration_ms, success, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = dbManager.db.transaction((logs) => {
      for (const log of logs) {
        insertStmt.run(
          log.timestamp || new Date().toISOString(),
          log.accountId || 'unknown',
          log.accountName || '未知账号',
          log.model || null,
          log.inputTokens || 0,
          log.outputTokens || 0,
          log.durationMs || 0,
          log.success !== false ? 1 : 0,
          log.errorMessage || null
        );
      }
    });

    insertMany(logs);

    // 备份原 JSON 文件
    const backupPath = path.join(dataDir, `request_logs.json.backup.${Date.now()}`);
    fs.copyFileSync(logsPath, backupPath);
    console.log(`✓ 已备份原文件到: ${backupPath}`);

    // 删除原 JSON 文件，防止重复迁移
    fs.unlinkSync(logsPath);
    console.log(`✓ 已删除原 JSON 文件，防止重复迁移`);

    console.log(`✓ 成功迁移 ${logs.length} 条日志记录到数据库`);
    
    return { migrated: logs.length, skipped: false };
  } catch (error) {
    console.error('❌ 数据迁移失败:', error.message);
    throw error;
  }
}
