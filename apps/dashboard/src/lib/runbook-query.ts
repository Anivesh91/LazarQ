export interface RunbooksQueryParams {
  page?: number;
  limit?: number;
  search?: string;
  tag?: string;
}

export interface RunbooksPaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function buildRunbooksQueryString(
  params: RunbooksQueryParams = {}
): string {
  const searchParams = new URLSearchParams();
  if (params.page && params.page > 0) {
    searchParams.set("page", String(Math.floor(params.page)));
  }
  if (params.limit && params.limit > 0) {
    searchParams.set("limit", String(Math.min(100, Math.floor(params.limit))));
  }

  const trimmedSearch = params.search?.trim();
  if (trimmedSearch) {
    searchParams.set("search", trimmedSearch);
  }

  const trimmedTag = params.tag?.trim().toLowerCase();
  if (trimmedTag) {
    searchParams.set("tag", trimmedTag);
  }

  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

export function normalizeRunbooksResponse<T>(
  res: {
    data?: T[];
    pagination?: Partial<RunbooksPaginationMeta>;
  },
  requestedParams: RunbooksQueryParams = {}
): {
  runbooks: T[];
  pagination: RunbooksPaginationMeta;
} {
  const runbooks = res.data || [];
  const limit = res.pagination?.limit ?? requestedParams.limit ?? 20;
  const page = res.pagination?.page ?? requestedParams.page ?? 1;
  const total = res.pagination?.total ?? runbooks.length;
  const totalPages =
    res.pagination?.totalPages ?? Math.max(1, Math.ceil(total / limit));

  return {
    runbooks,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, totalPages),
    },
  };
}
