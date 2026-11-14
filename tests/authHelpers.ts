import { vi } from "vitest";
import { User } from "../src/models/User.js";
import type { UserRole } from "../src/types/index.js";

export function mockAuthenticatedUser(
  userId: string,
  role: UserRole = "student",
  isActive = true,
): void {
  vi.spyOn(User, "findById").mockReturnValue(
    {
      select: vi.fn().mockResolvedValue({
        _id: userId,
        role,
        isActive,
      }),
    } as never,
  );
}
