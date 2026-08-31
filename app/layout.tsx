export default function RootLayout({ children }: { children: any }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="description"
          content="An infinite interactive AI-generated live stream."
        />
        <title>SLOP TV</title>
      </head>
      <body>{children}</body>
    </html>
  );
}
