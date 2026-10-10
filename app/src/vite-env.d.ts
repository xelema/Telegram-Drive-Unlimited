/// <reference types="vite/client" />

declare module 'virtual:telegram-drive-locale-keys' {
  const url: string | null;
  export default url;
}

declare module 'virtual:telegram-drive-bootstrap-copy' {
  const copy: Record<string, {title:string;loading:string;error:string;retry:string;dir:'rtl'|'ltr'}>;
  export default copy;
}
