export default function HomePage() {
  return (
    <div id="pumptv-page">
      <div id="pumptv-media-host" aria-hidden="true" />
      <main id="pumptv-root" className="shell" aria-live="polite" />
    </div>
  );
}
