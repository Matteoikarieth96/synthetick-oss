/**
 * Read every row of a PostgREST query (review B8). An unranged select is
 * silently capped at the server's max-rows setting (1,000 on Supabase): the
 * admin panel listed only the first 1,000 users and undercounted today's
 * usage once the ledger passed 1,000 rows in a day. Pure: the caller builds
 * the query, which must carry a stable ORDER BY (offset pages need one).
 */
export interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export async function selectAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize = 1000,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) return { data: out, error };
    out.push(...(data ?? []));
    if (!data || data.length < pageSize) return { data: out, error: null };
  }
}
