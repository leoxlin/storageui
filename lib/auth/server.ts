import "server-only"

import { cookies } from "next/headers"

import {
  isAuthEnabled,
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from "@/lib/auth/core"

/** Server actions must authorize independently of the page or proxy. */
export async function requireSession(): Promise<void> {
  if (!isAuthEnabled()) return
  const cookieStore = await cookies()
  if (
    !(await verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value))
  ) {
    throw new Error("Unauthorized.")
  }
}
