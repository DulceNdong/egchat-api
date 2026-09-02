/**
 * pg-client.cjs — Wrapper de PostgreSQL que replica la interfaz de @supabase/supabase-js
 * Permite usar Neon (o cualquier PostgreSQL) sin cambiar el código existente.
 *
 * Soporta: .from(table).select(cols).eq().neq().in().not().or().single().maybeSingle()
 *          .insert().update().delete().upsert().limit().range().order()
 *
 * Uso: const supabase = require('./pg-client.cjs');
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.SUPABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => console.error('[pg-client] Pool error:', err.message));

// ── Query builder ─────────────────────────────────────────────────────────────
class QueryBuilder {
  constructor(table) {
    this._table = table;
    this._op = 'select';
    this._cols = '*';
    this._conditions = [];
    this._params = [];
    this._paramIdx = 1;
    this._insertData = null;
    this._updateData = null;
    this._onConflict = null;
    this._limit = null;
    this._range = null;
    this._orderBy = null;
    this._single = false;
    this._maybeSingle = false;
    this._returning = null;
  }

  // ── SELECT ──────────────────────────────────────────────────────────────────
  select(cols = '*') {
    this._op = 'select';
    // Supabase join syntax: 'id, users(id, full_name)' → simplify to base cols
    // We handle simple joins by detecting parentheses
    this._cols = this._parseSelectCols(cols);
    return this;
  }

  _parseSelectCols(cols) {
    if (!cols || cols === '*') return '*';
    // Remove join sub-selects like 'users(id, name)' — keep only top-level cols
    // and expand joins as separate queries if needed (simplified: skip join cols)
    const parts = cols.split(',').map(c => c.trim());
    const simple = [];
    for (const p of parts) {
      if (p.includes('(')) {
        // It's a join — we'll handle it inline below
        simple.push(p);
      } else {
        simple.push(p);
      }
    }
    return simple.join(', ');
  }

  // ── INSERT ──────────────────────────────────────────────────────────────────
  insert(data) {
    this._op = 'insert';
    this._insertData = Array.isArray(data) ? data : [data];
    return this;
  }

  // ── UPDATE ──────────────────────────────────────────────────────────────────
  update(data) {
    this._op = 'update';
    this._updateData = data;
    return this;
  }

  // ── DELETE ──────────────────────────────────────────────────────────────────
  delete() {
    this._op = 'delete';
    return this;
  }

  // ── UPSERT ──────────────────────────────────────────────────────────────────
  upsert(data, opts = {}) {
    this._op = 'upsert';
    this._insertData = Array.isArray(data) ? data : [data];
    this._onConflict = opts.onConflict || null;
    return this;
  }

  // ── FILTERS ─────────────────────────────────────────────────────────────────
  eq(col, val) {
    if (val === null || val === undefined) {
      this._conditions.push(`"${col}" IS NULL`);
    } else {
      this._conditions.push(`"${col}" = $${this._paramIdx++}`);
      this._params.push(val);
    }
    return this;
  }

  neq(col, val) {
    this._conditions.push(`"${col}" != $${this._paramIdx++}`);
    this._params.push(val);
    return this;
  }

  in(col, vals) {
    if (!vals || vals.length === 0) {
      this._conditions.push('FALSE');
      return this;
    }
    const placeholders = vals.map(() => `$${this._paramIdx++}`).join(', ');
    this._conditions.push(`"${col}" IN (${placeholders})`);
    this._params.push(...vals);
    return this;
  }

  not(col, operator, val) {
    if (operator === 'is' && (val === null || val === undefined)) {
      this._conditions.push(`"${col}" IS NOT NULL`);
    } else {
      this._conditions.push(`NOT "${col}" = $${this._paramIdx++}`);
      this._params.push(val);
    }
    return this;
  }

  is(col, val) {
    if (val === null || val === undefined) {
      this._conditions.push(`"${col}" IS NULL`);
    } else if (val === true) {
      this._conditions.push(`"${col}" IS TRUE`);
    } else if (val === false) {
      this._conditions.push(`"${col}" IS FALSE`);
    } else {
      this._conditions.push(`"${col}" = $${this._paramIdx++}`);
      this._params.push(val);
    }
    return this;
  }

  lt(col, val) {
    this._conditions.push(`"${col}" < $${this._paramIdx++}`);
    this._params.push(val);
    return this;
  }

  lte(col, val) {
    this._conditions.push(`"${col}" <= $${this._paramIdx++}`);
    this._params.push(val);
    return this;
  }

  gt(col, val) {
    this._conditions.push(`"${col}" > $${this._paramIdx++}`);
    this._params.push(val);
    return this;
  }

  gte(col, val) {
    this._conditions.push(`"${col}" >= $${this._paramIdx++}`);
    this._params.push(val);
    return this;
  }

  ilike(col, pattern) {
    this._conditions.push(`"${col}" ILIKE $${this._paramIdx++}`);
    this._params.push(pattern);
    return this;
  }

  contains(col, val) {
    this._conditions.push(`"${col}" @> $${this._paramIdx++}`);
    this._params.push(JSON.stringify(val));
    return this;
  }

  or(filterStr) {
    // Parse simple 'col.eq.val,col2.eq.val2' format
    const parts = filterStr.split(',').map(p => p.trim());
    const orClauses = [];
    for (const p of parts) {
      const match = p.match(/^(\w+)\.(eq|neq|is)\.(.+)$/);
      if (match) {
        const [, col, op, rawVal] = match;
        const val = rawVal === 'null' ? null : rawVal;
        if (op === 'eq') {
          if (val === null) {
            orClauses.push(`"${col}" IS NULL`);
          } else {
            orClauses.push(`"${col}" = $${this._paramIdx++}`);
            this._params.push(val);
          }
        } else if (op === 'neq') {
          orClauses.push(`"${col}" != $${this._paramIdx++}`);
          this._params.push(val);
        } else if (op === 'is') {
          orClauses.push(val === null ? `"${col}" IS NULL` : `"${col}" IS NOT NULL`);
        }
      }
    }
    if (orClauses.length > 0) {
      this._conditions.push(`(${orClauses.join(' OR ')})`);
    }
    return this;
  }

  // ── MODIFIERS ───────────────────────────────────────────────────────────────
  limit(n) { this._limit = n; return this; }
  range(from, to) { this._range = { from, to }; return this; }
  order(col, opts = {}) {
    const dir = opts.ascending === false ? 'DESC' : 'ASC';
    this._orderBy = `"${col}" ${dir}`;
    return this;
  }
  single() { this._single = true; return this; }
  maybeSingle() { this._maybeSingle = true; return this; }

  // ── RETURNING ───────────────────────────────────────────────────────────────
  // Supabase chains .select() after insert/update to get returning data
  // We handle this by checking if _returning is set
  _setReturning(cols) { this._returning = cols || '*'; return this; }

  // ── EXECUTE ─────────────────────────────────────────────────────────────────
  async _execute() {
    let sql = '';
    let params = [...this._params];
    const where = this._conditions.length > 0
      ? ` WHERE ${this._conditions.join(' AND ')}`
      : '';

    try {
      if (this._op === 'select') {
        // Handle join syntax in cols
        const cols = this._resolveJoinCols();
        sql = `SELECT ${cols} FROM "${this._table}"${where}`;
        if (this._orderBy) sql += ` ORDER BY ${this._orderBy}`;
        if (this._limit !== null) sql += ` LIMIT ${this._limit}`;
        if (this._range) sql += ` LIMIT ${this._range.to - this._range.from + 1} OFFSET ${this._range.from}`;

        const res = await pool.query(sql, params);
        let data = res.rows;

        // Post-process join cols
        data = await this._resolveJoins(data);

        if (this._single) {
          if (data.length === 0) return { data: null, error: { message: 'No rows found', code: 'PGRST116' } };
          return { data: data[0], error: null };
        }
        if (this._maybeSingle) {
          return { data: data.length > 0 ? data[0] : null, error: null };
        }
        return { data, error: null };

      } else if (this._op === 'insert' || this._op === 'upsert') {
        const rows = this._insertData;
        if (!rows || rows.length === 0) return { data: null, error: { message: 'No data to insert' } };

        const results = [];
        for (const row of rows) {
          const keys = Object.keys(row).filter(k => row[k] !== undefined);
          if (keys.length === 0) continue;
          const cols = keys.map(k => `"${k}"`).join(', ');
          const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
          const vals = keys.map(k => row[k]);

          let q = `INSERT INTO "${this._table}" (${cols}) VALUES (${placeholders})`;
          if (this._op === 'upsert' && this._onConflict) {
            const conflictCols = this._onConflict.split(',').map(c => `"${c.trim()}"`).join(', ');
            const updateCols = keys.filter(k => !this._onConflict.includes(k))
              .map((k, i) => `"${k}" = EXCLUDED."${k}"`).join(', ');
            q += ` ON CONFLICT (${conflictCols}) DO ${updateCols ? `UPDATE SET ${updateCols}` : 'NOTHING'}`;
          }
          q += ` RETURNING *`;

          const r = await pool.query(q, vals);
          if (r.rows[0]) results.push(r.rows[0]);
        }

        const data = results.length === 1 ? results[0] : results;
        if (this._single || this._maybeSingle) return { data: results[0] || null, error: null };
        return { data, error: null };

      } else if (this._op === 'update') {
        const keys = Object.keys(this._updateData).filter(k => this._updateData[k] !== undefined);
        if (keys.length === 0) return { data: null, error: { message: 'No data to update' } };

        const setClause = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
        const vals = keys.map(k => this._updateData[k]);

        // Rebuild WHERE with offset params
        const whereOffset = keys.length;
        const whereConditions = this._conditions.map(c => {
          // Shift param indices
          return c.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + whereOffset}`);
        });
        const whereStr = whereConditions.length > 0 ? ` WHERE ${whereConditions.join(' AND ')}` : '';

        sql = `UPDATE "${this._table}" SET ${setClause}${whereStr} RETURNING *`;
        const allParams = [...vals, ...this._params];
        const res = await pool.query(sql, allParams);

        if (this._single || this._maybeSingle) return { data: res.rows[0] || null, error: null };
        return { data: res.rows, error: null };

      } else if (this._op === 'delete') {
        sql = `DELETE FROM "${this._table}"${where} RETURNING *`;
        const res = await pool.query(sql, params);
        return { data: res.rows, error: null };
      }
    } catch (err) {
      console.error(`[pg-client] Error on ${this._op} "${this._table}":`, err.message);
      return { data: null, error: { message: err.message, code: err.code } };
    }
  }

  // Handle Supabase join syntax: 'chat_id, user_id, users(id, phone, full_name, avatar_url)'
  _resolveJoinCols() {
    const cols = this._cols;
    if (!cols.includes('(')) return cols;

    const parts = cols.split(',').map(c => c.trim());
    const simple = parts.filter(p => !p.includes('('));
    return simple.length > 0 ? simple.join(', ') : '*';
  }

  async _resolveJoins(rows) {
    const cols = this._cols;
    if (!cols.includes('(') || rows.length === 0) return rows;

    // Parse join patterns like 'users(id, phone, full_name, avatar_url)'
    const joinPattern = /(\w+)\(([^)]+)\)/g;
    let match;
    const joins = [];
    while ((match = joinPattern.exec(cols)) !== null) {
      joins.push({ table: match[1], cols: match[2].trim() });
    }

    if (joins.length === 0) return rows;

    for (const join of joins) {
      // Detect FK column — look for {table}_id or {singular_table}_id in rows
      const singular = join.table.replace(/s$/, '');
      const fkCol = rows[0] && (
        rows[0][`${singular}_id`] !== undefined ? `${singular}_id` :
        rows[0][`${join.table}_id`] !== undefined ? `${join.table}_id` :
        null
      );

      if (!fkCol) continue;

      const ids = [...new Set(rows.map(r => r[fkCol]).filter(Boolean))];
      if (ids.length === 0) continue;

      try {
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
        const res = await pool.query(
          `SELECT ${join.cols} FROM "${join.table}" WHERE id IN (${placeholders})`,
          ids
        );
        const map = {};
        res.rows.forEach(r => { map[r.id] = r; });
        rows = rows.map(r => ({ ...r, [singular]: map[r[fkCol]] || null }));
      } catch {}
    }

    return rows;
  }

  // ── Thenable — permite await directamente ───────────────────────────────────
  then(resolve, reject) {
    return this._execute().then(resolve, reject);
  }
}

// ── Supabase-compatible client ────────────────────────────────────────────────
const pgClient = {
  from: (table) => {
    const qb = new QueryBuilder(table);

    // Return a proxy that chains .select() after .insert()/.update() for RETURNING
    return new Proxy(qb, {
      get(target, prop) {
        // When chaining .select() after insert/update/upsert, DON'T change _op
        // Just set the returning cols and keep _op as insert/update/upsert
        if (prop === 'select' && (target._op === 'insert' || target._op === 'update' || target._op === 'upsert')) {
          return (cols) => {
            target._setReturning(cols);
            // Do NOT change _op — keep it as insert/update/upsert
            // Return the same proxy so .single()/.maybeSingle() still work
            return new Proxy(target, {
              get(t2, p2) {
                if (p2 === 'select') {
                  return (c2) => { t2._setReturning(c2); return t2; };
                }
                return typeof t2[p2] === 'function' ? t2[p2].bind(t2) : t2[p2];
              }
            });
          };
        }
        return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
      }
    });
  },

  // Storage stub — returns error so code falls back to base64
  storage: {
    from: () => ({
      upload: async () => ({ data: null, error: { message: 'Storage migrado a ImageKit' } }),
      getPublicUrl: () => ({ data: { publicUrl: '' } }),
    }),
  },

  // Auth stub — not used in this backend
  auth: {
    signInWithPassword: async () => ({ data: null, error: { message: 'Auth no disponible' } }),
  },
};

module.exports = pgClient;
