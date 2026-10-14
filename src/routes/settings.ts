import type { Hono } from 'hono';
import type { AppEnv } from '../app-types';
import { ensureSensitiveConfigEncrypted, encryptConfigValue, MASKED_CONFIG_VALUE, SENSITIVE_CONFIG_KEYS } from '../services/config';

export function registerSettingsRoutes(app: Hono<AppEnv>): void {
  // ===================== Settings CRUD API =====================

  // 获取所有 Settings（按 category 分组）
  app.get('/api/settings/all', async (c) => {
    const db = c.env.DB;
    const settings = await db.prepare(
      'SELECT * FROM settings ORDER BY category, sort_order ASC, id ASC'
    ).all();

    const grouped: Record<string, any[]> = {};
    for (const s of settings.results) {
      const cat = (s as any).category;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(s);
    }
    return c.json(grouped);
  });

  // 获取 Settings 列表（按 category 筛选）
  app.get('/api/settings', async (c) => {
    const db = c.env.DB;
    const category = c.req.query('category');

    let sql = 'SELECT * FROM settings';
    const params: any[] = [];

    if (category) {
      sql += ' WHERE category = ?';
      params.push(category);
    }
    sql += ' ORDER BY category, sort_order ASC, id ASC';

    const settings = await db.prepare(sql).bind(...params).all();
    return c.json(settings.results);
  });

  // 图床分类与图片数量。分类本身由 settings(image_category) 管理。
  app.get('/api/images/categories', async (c) => {
    const db = c.env.DB;
    const [categoryRows, totals] = await Promise.all([
      db.prepare(
        `SELECT s.id, s.category, s.label, s.value, s.color, s.sort_order, s.is_active,
          COUNT(i.id) AS image_count
         FROM settings s
         LEFT JOIN images i ON i.category = s.value
         WHERE s.category = 'image_category'
         GROUP BY s.id, s.category, s.label, s.value, s.color, s.sort_order, s.is_active
         ORDER BY s.sort_order ASC, s.id ASC`
      ).all(),
      db.prepare(
        `SELECT COUNT(*) AS total,
          SUM(CASE WHEN category IS NULL OR TRIM(category) = '' THEN 1 ELSE 0 END) AS unclassified_count
         FROM images`
      ).first<{ total: number; unclassified_count: number }>()
    ]);
    return c.json({
      categories: categoryRows.results,
      total: totals?.total || 0,
      unclassified_count: totals?.unclassified_count || 0
    });
  });

  // 创建 Setting
  app.post('/api/settings', async (c) => {
    const db = c.env.DB;
    const body = await c.req.json();
    const { category, label, value, color, sort_order, is_active } = body;

    if (!/^[a-z0-9_-]{1,40}$/i.test(String(category || '')) || !String(label || '').trim() || !String(value || '').trim()) {
      return c.json({ error: 'category、label 和 value 必填，category 只能包含字母、数字、下划线或连字符' }, 400);
    }
    if (category === 'system_node_type' && !/^[\p{L}\p{N}_-]{1,40}$/u.test(String(value).trim())) {
      return c.json({ error: '脑图节点类型值只能包含文字、数字、下划线或连字符，最多 40 个字符' }, 400);
    }

    const sql = `INSERT INTO settings (category, label, value, color, sort_order, is_active)
      VALUES (?, ?, ?, ?, ?, ?)`;

    const res = await db.prepare(sql).bind(
      category, String(label).trim(), String(value).trim(),
      color || null, sort_order !== undefined ? sort_order : 0, is_active === false ? 0 : 1
    ).run();

    return c.json({ id: res.meta.last_row_id, success: true }, 201);
  });

  // 更新 Setting
  app.put('/api/settings/:id', async (c) => {
    const id = c.req.param('id');
    const db = c.env.DB;
    const body = await c.req.json();
    const current = await db.prepare('SELECT category, value FROM settings WHERE id = ?').bind(id)
      .first<{ category: string; value: string }>();
    if (!current) return c.json({ error: '设置项不存在' }, 404);

    const nextCategory = String(body.category ?? current.category);
    const nextValue = String(body.value ?? current.value).trim();
    if (nextCategory === 'system_node_type' && !/^[\p{L}\p{N}_-]{1,40}$/u.test(nextValue)) {
      return c.json({ error: '脑图节点类型值只能包含文字、数字、下划线或连字符，最多 40 个字符' }, 400);
    }
    if (current.category === 'system_node_type' && nextCategory !== 'system_node_type') {
      const used = await db.prepare('SELECT id FROM trading_system_nodes WHERE node_type = ? LIMIT 1').bind(current.value).first();
      if (used) return c.json({ error: '该节点类型正在使用，不能移动到其他分类' }, 409);
    }
    if (current.category === 'image_category' && nextCategory !== 'image_category') {
      const used = await db.prepare('SELECT id FROM images WHERE category = ? LIMIT 1').bind(current.value).first();
      if (used) return c.json({ error: '该图片分类正在使用，不能移动到其他设置分类' }, 409);
    }
    if (current.category === 'mindmap_category' && nextCategory !== 'mindmap_category') {
      const used = await db.prepare('SELECT id FROM trading_systems WHERE category = ? LIMIT 1').bind(current.value).first();
      if (used) return c.json({ error: '该脑图分类正在使用，不能移动到其他设置分类' }, 409);
      const otherCategory = await db.prepare(
        "SELECT id FROM settings WHERE category = 'mindmap_category' AND id != ? LIMIT 1"
      ).bind(id).first();
      if (!otherCategory) return c.json({ error: '至少需要保留一个脑图分类' }, 409);
    }
    if (current.category === 'mindmap_category' && body.is_active === false) {
      const used = await db.prepare('SELECT id FROM trading_systems WHERE category = ? LIMIT 1').bind(current.value).first();
      if (used) return c.json({ error: '使用中的脑图分类不能停用，请先移动相关脑图' }, 409);
      const otherActive = await db.prepare(
        "SELECT id FROM settings WHERE category = 'mindmap_category' AND is_active = 1 AND id != ? LIMIT 1"
      ).bind(id).first();
      if (!otherActive) return c.json({ error: '至少需要保留一个启用的脑图分类' }, 409);
    }

    const fields: string[] = [];
    const values: any[] = [];

    const updatable = ['category', 'label', 'value', 'color', 'sort_order', 'is_active'];

    for (const field of updatable) {
      if (body[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(field === 'is_active' ? (body[field] ? 1 : 0) : body[field]);
      }
    }

    if (fields.length === 0) return c.json({ error: 'No fields to update' }, 400);

    fields.push("updated_at = datetime('now')");
    values.push(id);

    const sql = `UPDATE settings SET ${fields.join(', ')} WHERE id = ?`;
    const updateSetting = db.prepare(sql).bind(...values);
    if (current.category === 'system_node_type' && nextCategory === 'system_node_type' && nextValue !== current.value) {
      await db.batch([
        updateSetting,
        db.prepare("UPDATE trading_system_nodes SET node_type = ?, updated_at = datetime('now') WHERE node_type = ?")
          .bind(nextValue, current.value)
      ]);
    } else if (current.category === 'image_category' && nextCategory === 'image_category' && nextValue !== current.value) {
      await db.batch([
        updateSetting,
        db.prepare('UPDATE images SET category = ? WHERE category = ?').bind(nextValue, current.value)
      ]);
    } else if (current.category === 'mindmap_category' && nextCategory === 'mindmap_category' && nextValue !== current.value) {
      await db.batch([
        updateSetting,
        db.prepare("UPDATE trading_systems SET category = ?, updated_at = datetime('now') WHERE category = ?").bind(nextValue, current.value)
      ]);
    } else {
      await updateSetting.run();
    }

    return c.json({ success: true });
  });

  // 删除 Setting
  app.delete('/api/settings/:id', async (c) => {
    const id = c.req.param('id');
    const db = c.env.DB;
    const current = await db.prepare('SELECT category, value FROM settings WHERE id = ?').bind(id)
      .first<{ category: string; value: string }>();
    if (!current) return c.json({ error: '设置项不存在' }, 404);
    if (current.category === 'system_node_type') {
      const used = await db.prepare('SELECT id FROM trading_system_nodes WHERE node_type = ? LIMIT 1').bind(current.value).first();
      if (used) return c.json({ error: '该节点类型正在脑图中使用，请先修改相关节点' }, 409);
    }
    if (current.category === 'image_category') {
      await db.batch([
        db.prepare('UPDATE images SET category = NULL WHERE category = ?').bind(current.value),
        db.prepare('DELETE FROM settings WHERE id = ?').bind(id)
      ]);
    } else if (current.category === 'mindmap_category') {
      const [used, categoryCount] = await Promise.all([
        db.prepare('SELECT id FROM trading_systems WHERE category = ? LIMIT 1').bind(current.value).first(),
        db.prepare("SELECT COUNT(*) AS count FROM settings WHERE category = 'mindmap_category'").first<{ count: number }>()
      ]);
      if (used) return c.json({ error: '该分类中仍有脑图。脑图不允许未分类，请先把脑图移动到其他分类' }, 409);
      if (Number(categoryCount?.count || 0) <= 1) return c.json({ error: '至少需要保留一个脑图分类' }, 409);
      await db.prepare('DELETE FROM settings WHERE id = ?').bind(id).run();
    } else {
      await db.prepare('DELETE FROM settings WHERE id = ?').bind(id).run();
    }
    return c.json({ success: true });
  });

  // ===================== App Config API =====================

  // 获取所有 Config（敏感字段掩码，修复 #5）
  app.get('/api/config', async (c) => {
    const db = c.env.DB;
    await ensureSensitiveConfigEncrypted(c.env);
    const configs = await db.prepare('SELECT * FROM app_config').all();
    const masked = configs.results.map((r) => {
      if (SENSITIVE_CONFIG_KEYS.has((r as any).config_key) && (r as any).config_value) {
        return { ...r, config_value: MASKED_CONFIG_VALUE };
      }
      return r;
    });
    return c.json(masked);
  });

  // 更新 Config（支持批量 key-value）
  app.put('/api/config', async (c) => {
    const db = c.env.DB;
    const raw = await c.req.json().catch(() => null);

    // body 可以是 { key: value, ... } 或 [{ key, value }, ...]
    let entries: { key: string; value: string }[] = [];

    if (Array.isArray(raw)) {
      entries = raw;
    } else if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        entries.push({ key, value: String(value) });
      }
    }

    for (const entry of entries) {
      // 跳过被掩码的占位符，避免把真实 token 覆盖成蒙版值
      if (SENSITIVE_CONFIG_KEYS.has(entry.key) && entry.value === MASKED_CONFIG_VALUE) continue;
      const storedValue=SENSITIVE_CONFIG_KEYS.has(entry.key)
        ? await encryptConfigValue(c.env.CONFIG_ENCRYPTION_KEY,entry.key,entry.value)
        : entry.value;
      await db.prepare(
        `INSERT INTO app_config (config_key, config_value) VALUES (?, ?)
         ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = datetime('now')`
      ).bind(entry.key, storedValue).run();
    }

    return c.json({ success: true });
  });

  }
