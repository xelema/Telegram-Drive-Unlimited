/// <reference types="vite/client" />

// Build-time subsets of the canonical English catalog; no duplicate source data.
declare module '*.json?core' {
  const resource: Record<string, object>;
  export default resource;
}
declare module '*.json?supporter' {
  const resource: Record<string, object>;
  export default resource;
}
