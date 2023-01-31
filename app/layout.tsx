import '../styles/globals.css'

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  let header = (
    <header className="text-3xl">
      kualta writes things
    </header>
  );
  return (
    <html>
      <head />
      <body>
        {header}
        {children}
      </body>
    </html>
  )
}
