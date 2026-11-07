import { createIsomorphicFn } from "@tanstack/react-start";
import {
  getCookie,
  getRequestHeader,
  getResponseHeader,
  setResponseHeader,
} from "@tanstack/react-start/server";
import Cookies from "js-cookie";

import {
  lastLocaleKey,
  localeCookie,
  resolveClientLocale,
  resolveRequestLocale,
} from "@/src/lib/locale";

export const getRequestLocale = createIsomorphicFn()
  .server(() => {
    const locale = resolveRequestLocale(
      getCookie(localeCookie),
      getRequestHeader("accept-language"),
    );
    const vary = getResponseHeader("Vary");
    setResponseHeader("Vary", [vary, "Accept-Language", "Cookie"].filter(Boolean).join(", "));
    setResponseHeader("Content-Language", locale);
    setResponseHeader("Cache-Control", "private, no-store");
    return locale;
  })
  .client(() => {
    let savedLocale: string | null = null;
    try {
      savedLocale = localStorage.getItem(lastLocaleKey);
    } catch {
      // Browser preferences still work when persistent storage is unavailable.
    }
    const cookie = Cookies.get(localeCookie);
    return resolveClientLocale({
      cookie,
      serverLocale:
        document.documentElement.dataset.offlineShell === "true"
          ? undefined
          : document.documentElement.lang,
      savedLocale,
      languages: navigator.languages,
    });
  });
