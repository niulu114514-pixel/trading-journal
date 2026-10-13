export function sessionBackedDatabase(database: D1Database, session: D1DatabaseSession): D1Database {
  return {
    prepare: (query: string) => session.prepare(query),
    batch: <T = unknown>(statements: D1PreparedStatement[]) => session.batch<T>(statements),
    exec: (query: string) => database.exec(query),
    withSession: (constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint) => database.withSession(constraintOrBookmark),
    dump: () => database.dump()
  };
}

export function d1SessionConstraint(request: Request): D1SessionBookmark | D1SessionConstraint {
  const bookmark = request.headers.get('X-D1-Bookmark')?.trim();
  if (bookmark && bookmark.length <= 2048) return bookmark;

  const path = new URL(request.url).pathname;
  const hasSessionCookie = /(?:^|;\s*)session=/.test(request.headers.get('Cookie') || '');
  return path.startsWith('/api/auth/') || hasSessionCookie ? 'first-primary' : 'first-unconstrained';
}
