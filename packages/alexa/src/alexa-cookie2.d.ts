declare module "alexa-cookie2" {
  interface AlexaCookie {
    generateAlexaCookie(
      email: undefined,
      password: undefined,
      options: { readonly [key: string]: unknown },
      callback: (error: Error | null | undefined, result: unknown) => void
    ): void
    stopProxyServer(callback?: () => void): void
  }
  const alexaCookie: AlexaCookie
  export default alexaCookie
}
