import Link from "next/link";

const steps = [
  {
    n: "01",
    title: "Upload, or paste a listing link",
    body: "Add the floor plan and the photos you already have. Or paste a Prosperty listing link and we pull in its plans and photos for you.",
  },
  {
    n: "02",
    title: "We read the floor plan",
    body: "Walls, doors, windows and rooms, with real dimensions and areas. Homes with more than one floor work too. You check the result before anything is built.",
  },
  {
    n: "03",
    title: "Photos find their rooms",
    body: "Each photo is matched to the room it shows and pinned where it was taken. Fix anything we got wrong with drag and drop.",
  },
  {
    n: "04",
    title: "Furniture is rebuilt in 3D",
    body: "The beds, sofas and tables in your photos are rebuilt as 3D models at the right size and put back where they stand. Walk through it or view it as a dollhouse.",
  },
];

const outputs = [
  { name: "Floor plan as data", out: "Every room's name, size, doors and windows, not just a picture" },
  { name: "Photo-placed tour", out: "Each photo pinned in the room and spot it was taken from" },
  { name: "Furnished 3D model", out: "The whole home with its furniture, built from your photos" },
  { name: "Share link", out: "Send the tour to renters, buyers or guests, or put it in your listing" },
];

const audiences = [
  {
    title: "Owners & hosts",
    body: "Rent, sell or get booked with fewer wasted viewings. You don't need scanning hardware or a photographer. The photos from your listing are enough.",
  },
  {
    title: "Agencies & property managers",
    body: "Keep every property in a shared workspace, invite your team, and import listings by link instead of uploading each file.",
  },
  {
    title: "Renters, buyers & guests",
    body: "Know the layout, the room sizes and where the furniture fits before you go to a viewing.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <span className="text-base font-semibold tracking-tight">gameHome</span>
        <nav className="flex items-center gap-5 text-sm">
          <a href="#how" className="hidden text-neutral-600 hover:text-neutral-900 sm:inline">
            How it works
          </a>
          <a href="#agents" className="hidden text-neutral-600 hover:text-neutral-900 sm:inline">
            For AI agents
          </a>
          <Link href="/login" className="text-neutral-600 hover:text-neutral-900">
            Sign in
          </Link>
          <Link
            href="/login?next=/app"
            className="rounded-full bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-700"
          >
            Get started
          </Link>
        </nav>
      </header>

      <main>
        <section className="mx-auto grid w-full max-w-6xl gap-12 px-4 pt-12 pb-20 sm:px-6 md:grid-cols-[1.1fr_1fr] md:items-center md:pt-20">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-accent">
              Floor plan + photos → furnished 3D home
            </p>
            <h1 className="mt-4 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl md:text-6xl">
              Walk through the home before you visit.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-neutral-600">
              Upload a floor plan and the photos of a house or apartment, or paste a listing link.
              gameHome reads the plan, places every photo in its room and rebuilds the furniture in
              3D, so people can walk through the home before they book a viewing.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/login?next=/app"
                className="rounded-full bg-accent px-6 py-3 text-sm font-medium text-white hover:brightness-110"
              >
                Get started free
              </Link>
              <Link
                href="/tour/demo"
                className="rounded-full border border-black/15 px-6 py-3 text-sm font-medium hover:bg-black/5"
              >
                Open the 3D demo
              </Link>
            </div>
          </div>

          <PlanIllustration />
        </section>

        <section id="how" className="border-t border-black/10 bg-[#fbf9f5]">
          <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
            <h2 className="text-3xl font-semibold tracking-tight">From listing photos to a home you can walk through.</h2>
            <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {steps.map((s) => (
                <div key={s.n}>
                  <span className="font-mono text-sm text-accent">{s.n}</span>
                  <h3 className="mt-2 text-lg font-semibold">{s.title}</h3>
                  <p className="mt-2 leading-relaxed text-neutral-600">{s.body}</p>
                </div>
              ))}
            </div>

            <div className="mt-16 overflow-hidden rounded-2xl border border-black/10">
              {outputs.map((o, i) => (
                <div
                  key={o.name}
                  className={`grid gap-1 px-5 py-4 sm:grid-cols-[220px_1fr] sm:items-center ${
                    i > 0 ? "border-t border-black/10" : ""
                  }`}
                >
                  <span className="font-semibold">{o.name}</span>
                  <span className="text-sm text-neutral-700">{o.out}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
          <h2 className="text-3xl font-semibold tracking-tight">For everyone on both sides of a viewing</h2>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {audiences.map((a) => (
              <div key={a.title} className="rounded-2xl border border-black/10 bg-white/60 p-6">
                <h3 className="font-semibold">{a.title}</h3>
                <p className="mt-2 leading-relaxed text-neutral-600">{a.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="agents" className="bg-neutral-900 text-neutral-100">
          <div className="mx-auto grid w-full max-w-6xl gap-12 px-4 py-20 sm:px-6 md:grid-cols-2 md:items-center">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-[#e8936c]">
                Coming next · MCP server
              </p>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight">
                Homes your AI assistant can actually read.
              </h2>
              <p className="mt-4 leading-relaxed text-neutral-400">
                Every home on gameHome already comes with a structured floor plan: rooms, sizes,
                windows, layout. Next, we&apos;re opening that up over MCP, so AI agents can search
                homes by per-room details that listing portals can&apos;t filter on and send you
                straight into the 3D tour.
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5 font-mono text-[13px] leading-relaxed">
              <p className="text-neutral-400">you</p>
              <p className="mt-1">
                Find me a place to rent in central Athens, 50–90 m², up to €900/month, one bedroom
                over 12 m², with a balcony.
              </p>
              <p className="mt-5 text-neutral-400">agent → gameHome</p>
              <p className="mt-1 text-[#e8936c]">
                search_listings({"{"} location: &quot;Athens centre&quot;, area_m2: {"{"} min: 50, max: 90 {"}"},
                price: {"{"} max: 900 {"}"}, amenities: [&quot;balcony&quot;] {"}"})
              </p>
              <p className="mt-1 text-[#e8936c]">get_floor_plan(&quot;koukaki-2br&quot;)</p>
              <p className="mt-5 text-neutral-400">agent</p>
              <p className="mt-1">
                3 matches. Best fit: Koukaki, 78 m², €850. Master bedroom 18 m² with two windows,
                9.6 m² balcony. <span className="underline">Open 3D tour →</span>
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-neutral-500 sm:px-6">
        <span>© 2026 gameHome</span>
        <div className="flex gap-5">
          <Link href="/tour/demo" className="hover:text-neutral-900">
            Demo tour
          </Link>
          <Link href="/login" className="hover:text-neutral-900">
            Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}

function PlanIllustration() {
  return (
    <div className="relative aspect-[10/9] w-full rounded-3xl border border-black/10 bg-[#fbf9f5] p-6 shadow-sm">
      <svg viewBox="-0.6 -2.2 11.2 10.6" className="h-full w-full" aria-label="Floor plan illustration">
        <g fill="none" stroke="#d8cfc4" strokeWidth="0.03" strokeDasharray="0.12 0.12">
          <rect x="0" y="-1.6" width="6" height="1.6" />
        </g>
        <g fill="#efe6d8">
          <rect x="0" y="0" width="6" height="4.5" />
        </g>
        <g fill="#e3eadf">
          <rect x="6" y="0" width="4" height="4.5" />
          <rect x="4.5" y="4.5" width="5.5" height="3.3" />
        </g>
        <rect x="0" y="4.5" width="2.5" height="3.3" fill="#dde8ed" />
        <g stroke="#1c1a17" strokeLinecap="square" fill="none">
          <path d="M0 0 H2 M3.6 0 H7.2 M8.6 0 H10 V1.5 M10 2.7 V5.2 M10 6.6 V7.8 H7.5 M5.9 7.8 H4 M3 7.8 H1.8 M1.2 7.8 H0 V3.3 M0 1.9 V0" strokeWidth="0.25" />
          <path d="M6 0 V3.4 M6 4.3 V4.5 M0 4.5 H2.8 M4 4.5 H10 M2.5 4.5 V5.1 M2.5 5.9 V7.8 M4.5 4.5 V5.3 M4.5 6.2 V7.8" strokeWidth="0.12" />
        </g>
        <g fontSize="0.34" fill="#1c1a17" fontFamily="var(--font-geist-sans)" textAnchor="middle">
          <text x="3" y="2.2">Living</text>
          <text x="3" y="2.65" fill="#7a7268" fontSize="0.28">27.0 m²</text>
          <text x="8" y="2.2">Bedroom</text>
          <text x="8" y="2.65" fill="#7a7268" fontSize="0.28">18.0 m²</text>
          <text x="7.25" y="6.1">Bedroom</text>
          <text x="7.25" y="6.55" fill="#7a7268" fontSize="0.28">18.2 m²</text>
          <text x="1.25" y="6.1">Bath</text>
          <text x="3" y="-0.65" fill="#7a7268" fontSize="0.28">Balcony</text>
        </g>
      </svg>
      <Link
        href="/tour/demo"
        className="absolute right-5 bottom-5 rounded-full bg-neutral-900 px-4 py-2 text-xs font-medium text-white shadow-md hover:bg-neutral-700"
      >
        View in 3D →
      </Link>
    </div>
  );
}
