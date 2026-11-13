import Cookies from "js-cookie";

import { lastLocaleKey, localeCookie } from "@/src/lib/locale";
import type { Locale } from "@/src/lib/locale";
export function saveLanguage(locale: Locale) {
  Cookies.set(localeCookie, locale, {
    path: "/",
    expires: 365,
    sameSite: "Lax",
    secure: window.location.protocol === "https:",
  });
  try {
    localStorage.setItem(lastLocaleKey, locale);
  } catch {
    /* Cookie remains available. */
  }
}
