import { createContext } from "react";

export const PwaInstallContext = createContext<{
  available: boolean;
  pending: boolean;
  install: () => void;
}>({ available: false, pending: false, install: () => undefined });
