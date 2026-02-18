/**
 * 数据迁移脚本：初始化模型管理和映射表
 */
export async function migrateModels(dbManager, dataDir) {
  try {
    console.log('📦 开始同步默认模型数据...');

    // 使用事务插入默认数据
    const migrate = dbManager.db.transaction(() => {
      let insertedModels = 0;
      let insertedMappings = 0;

      // 插入默认模型
      const modelStmt = dbManager.db.prepare(`
        INSERT OR IGNORE INTO models (id, display_name, max_tokens, created, owned_by, enabled, display_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const defaultModels = [
        ['claude-sonnet-4-6-20260217-thinking', 'Claude Sonnet 4.6 (Thinking)', 1000000, 1771286400, 'anthropic', 1, 1],
        ['claude-sonnet-4-6-20260217', 'Claude Sonnet 4.6', 1000000, 1771286400, 'anthropic', 1, 2],
        ['claude-sonnet-4.6', 'Claude Sonnet 4.6 (Legacy Alias)', 1000000, 1771286400, 'anthropic', 1, 3],
        ['claude-opus-4.6', 'Claude Opus 4.6', 200000, 1771286400, 'anthropic', 1, 4],
        ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 200000, 1727568000, 'anthropic', 1, 5],
        ['claude-opus-4-5-20251101', 'Claude Opus 4.5', 200000, 1730419200, 'anthropic', 1, 6],
        ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200000, 1727740800, 'anthropic', 1, 7]
      ];

      for (const model of defaultModels) {
        insertedModels += modelStmt.run(...model).changes;
      }

      // 插入默认映射规则
      const mappingStmt = dbManager.db.prepare(`
        INSERT OR IGNORE INTO model_mappings (external_pattern, internal_id, match_type, priority, enabled)
        VALUES (?, ?, ?, ?, ?)
      `);

      const defaultMappings = [
        // 精确/显式模型优先：保留显式请求 4.5 的能力
        ['^claude[-_.]?sonnet[-_.]?4[-_.]?6[-_.]?20260217[-_.]?thinking$', 'claude-sonnet-4-6-20260217-thinking', 'regex', 160, 1],
        ['^claude[-_.]?sonnet[-_.]?4[-_.]?6[-_.]?20260217$', 'claude-sonnet-4-6-20260217', 'regex', 150, 1],
        ['claude[-_.]?sonnet[-_.]?4[-_.]?6(?:[-_.]\\d+)?', 'claude-sonnet-4-6-20260217-thinking', 'regex', 120, 1],
        ['claude[-_.]?sonnet[-_.]?4[-_.]?5(?:[-_.]\\d+)?', 'claude-sonnet-4-5-20250929', 'regex', 110, 1],
        ['claude[-_.]?opus[-_.]?4[-_.]?6(?:[-_.]\\d+)?', 'claude-opus-4.6', 'regex', 120, 1],
        ['claude[-_.]?opus[-_.]?4[-_.]?5(?:[-_.]\\d+)?', 'claude-opus-4-5-20251101', 'regex', 110, 1],
        ['claude[-_.]?haiku[-_.]?4[-_.]?5(?:[-_.]\\d+)?', 'claude-haiku-4-5-20251001', 'regex', 110, 1],
        // 默认语义映射：未带版本时走最新稳定模型
        ['sonnet', 'claude-sonnet-4-6-20260217-thinking', 'contains', 10, 1],
        ['opus', 'claude-opus-4.6', 'contains', 10, 1],
        ['haiku', 'claude-haiku-4-5-20251001', 'contains', 10, 1]
      ];

      for (const mapping of defaultMappings) {
        insertedMappings += mappingStmt.run(...mapping).changes;
      }

      // 兼容升级：仅替换默认旧映射，不覆盖用户自定义映射
      insertedMappings += dbManager.db.prepare(`
        UPDATE model_mappings
        SET internal_id = 'claude-sonnet-4-6-20260217-thinking', match_type = 'contains', priority = 10, enabled = 1
        WHERE external_pattern = 'sonnet'
          AND match_type = 'contains'
          AND internal_id IN (
            'claude-sonnet-4.5',
            'claude-sonnet-4-5-20250929',
            'claude-sonnet-4.6',
            'claude-sonnet-4-6-20260217'
          )
      `).run().changes;

      insertedMappings += dbManager.db.prepare(`
        UPDATE model_mappings
        SET internal_id = 'claude-opus-4.6', match_type = 'contains', priority = 10, enabled = 1
        WHERE external_pattern = 'opus'
          AND match_type = 'contains'
          AND internal_id IN ('claude-sonnet-4.5', 'claude-opus-4.5', 'claude-opus-4-5-20251101')
      `).run().changes;

      insertedMappings += dbManager.db.prepare(`
        UPDATE model_mappings
        SET internal_id = 'claude-haiku-4-5-20251001', match_type = 'contains', priority = 10, enabled = 1
        WHERE external_pattern = 'haiku'
          AND match_type = 'contains'
          AND internal_id = 'claude-haiku-4.5'
      `).run().changes;

      // 兼容升级：修正旧的 4.5 映射ID到当前实际模型ID
      insertedMappings += dbManager.db.prepare(`
        UPDATE model_mappings
        SET internal_id = 'claude-sonnet-4-5-20250929'
        WHERE external_pattern = 'claude[-_.]?sonnet[-_.]?4[-_.]?5(?:[-_.]\\d+)?'
          AND match_type = 'regex'
          AND internal_id = 'claude-sonnet-4.5'
      `).run().changes;

      insertedMappings += dbManager.db.prepare(`
        UPDATE model_mappings
        SET internal_id = 'claude-sonnet-4-6-20260217-thinking'
        WHERE external_pattern = 'claude[-_.]?sonnet[-_.]?4[-_.]?6(?:[-_.]\\d+)?'
          AND match_type = 'regex'
          AND internal_id IN ('claude-sonnet-4.6', 'claude-sonnet-4-6-20260217')
      `).run().changes;

      insertedMappings += dbManager.db.prepare(`
        UPDATE model_mappings
        SET internal_id = 'claude-opus-4-5-20251101'
        WHERE external_pattern = 'claude[-_.]?opus[-_.]?4[-_.]?5(?:[-_.]\\d+)?'
          AND match_type = 'regex'
          AND internal_id = 'claude-opus-4.5'
      `).run().changes;

      insertedMappings += dbManager.db.prepare(`
        UPDATE model_mappings
        SET internal_id = 'claude-haiku-4-5-20251001'
        WHERE external_pattern = 'claude[-_.]?haiku[-_.]?4[-_.]?5(?:[-_.]\\d+)?'
          AND match_type = 'regex'
          AND internal_id = 'claude-haiku-4.5'
      `).run().changes;

      // 同步默认模型的上下文窗口（仅更新旧默认值 32000）
      insertedModels += dbManager.db.prepare(`
        UPDATE models
        SET max_tokens = 1000000
        WHERE id IN (
          'claude-sonnet-4-6-20260217-thinking',
          'claude-sonnet-4-6-20260217',
          'claude-sonnet-4.6'
        )
          AND max_tokens = 32000
      `).run().changes;

      insertedModels += dbManager.db.prepare(`
        UPDATE models
        SET max_tokens = 200000
        WHERE id IN (
          'claude-opus-4.6',
          'claude-sonnet-4-5-20250929',
          'claude-opus-4-5-20251101',
          'claude-haiku-4-5-20251001'
        )
          AND max_tokens = 32000
      `).run().changes;

      return { insertedModels, insertedMappings };
    });

    const result = migrate();

    if (result.insertedModels > 0 || result.insertedMappings > 0) {
      console.log(
        `✓ 默认模型同步完成: models +${result.insertedModels}, mappings +${result.insertedMappings}`
      );
    } else {
      console.log('✓ 默认模型已是最新，无需变更');
    }

    return {
      migrated: result.insertedModels + result.insertedMappings,
      skipped: false,
      insertedModels: result.insertedModels,
      insertedMappings: result.insertedMappings
    };
  } catch (error) {
    console.error('❌ 模型数据同步失败:', error.message);
    return { migrated: 0, skipped: false, error: error.message };
  }
}
