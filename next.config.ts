import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // Fija el root del workspace a esta carpeta. Sin esto, Next infiere el root
  // en el directorio padre (hay un package-lock.json suelto ahí) y eso rompe el
  // dev server cuando el repo corre desde un git worktree en paralelo.
  turbopack: { root: __dirname },
};

export default nextConfig;
