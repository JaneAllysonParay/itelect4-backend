import { z } from "zod";
import type { Response } from "express";

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function setPaginationHeaders(res: Response, page: number, pageSize: number, totalCount: number): void {
  res.setHeader("X-Page", String(page));
  res.setHeader("X-Page-Size", String(pageSize));
  res.setHeader("X-Total-Count", String(totalCount));
  res.setHeader("X-Has-More", String(page * pageSize < totalCount));
}
