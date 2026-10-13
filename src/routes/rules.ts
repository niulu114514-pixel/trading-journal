import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';

const ruleFields = {
  title: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(80),
  content: z.string().max(8_000),
  tags: z.string().max(1_000).nullable(),
  is_active: z.boolean(),
  priority: z.number().int().min(-10_000).max(10_000)
};

const createRuleSchema = z.object({
  title: ruleFields.title,
  category: ruleFields.category.optional(),
  content: ruleFields.content.optional(),
  tags: ruleFields.tags.optional(),
  is_active: ruleFields.is_active.optional(),
  priority: ruleFields.priority.optional()
});

const updateRuleSchema = z.object(ruleFields).partial();

export function registerRuleRoutes(app: Hono<AppEnv>): void {
  app.get('/api/rules', async context => {
    const category = context.req.query('category');
    const active = context.req.query('active');
    const where = ['1=1'];
    const parameters: unknown[] = [];
    if (category) { where.push('category = ?'); parameters.push(category); }
    if (active !== undefined) { where.push('is_active = ?'); parameters.push(active === 'true' ? 1 : 0); }
    const rules = await context.env.DB.prepare(
      `SELECT * FROM trading_rules WHERE ${where.join(' AND ')} ORDER BY priority DESC, created_at DESC`
    ).bind(...parameters).all();
    return context.json(rules.results);
  });

  app.get('/api/rules/:id', async context => {
    const rule = await context.env.DB.prepare('SELECT * FROM trading_rules WHERE id = ?')
      .bind(context.req.param('id')).first();
    return rule ? context.json(rule) : context.json({ error: 'Not found' }, 404);
  });

  app.post('/api/rules', async context => {
    const parsed = createRuleSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: '参数校验失败', issues: parsed.error.issues }, 400);
    const rule = parsed.data;
    const result = await context.env.DB.prepare(
      `INSERT INTO trading_rules (title, category, content, tags, is_active, priority) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      rule.title,
      rule.category || '入场规则',
      rule.content || '',
      rule.tags || null,
      rule.is_active === undefined || rule.is_active ? 1 : 0,
      rule.priority || 0
    ).run();
    return context.json({ id: result.meta.last_row_id, success: true }, 201);
  });

  app.put('/api/rules/:id', async context => {
    const parsed = updateRuleSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: '参数校验失败', issues: parsed.error.issues }, 400);
    const entries = Object.entries(parsed.data);
    if (!entries.length) return context.json({ error: 'No fields to update' }, 400);

    const fields = entries.map(([field]) => `${field} = ?`);
    const values = entries.map(([field, value]) => field === 'is_active' ? (value ? 1 : 0) : value);
    fields.push("updated_at = datetime('now')");
    const result = await context.env.DB.prepare(`UPDATE trading_rules SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values, context.req.param('id')).run();
    if (!result.meta.changes) return context.json({ error: 'Not found' }, 404);
    return context.json({ success: true });
  });

  app.delete('/api/rules/:id', async context => {
    const result = await context.env.DB.prepare('DELETE FROM trading_rules WHERE id = ?')
      .bind(context.req.param('id')).run();
    if (!result.meta.changes) return context.json({ error: 'Not found' }, 404);
    return context.json({ success: true });
  });
}
