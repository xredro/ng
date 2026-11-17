#!/usr/bin/env python3
"""Regenerates index.html (public homepage), sitemap.xml and robots.txt.
Run from the project root:  python3 tools/build-home.py
The nav block is copied verbatim from the current index.html so it never changes."""
import re, os, json, glob

BASE = "https://xredro.github.io/ng/"
EMAIL = "xredrocontact@gmail.com"
WA = "https://wa.me/2347055274048"
SMS = "sms:+2347055274048"
DATE = "2026-11-01"

src = open("index.html", encoding="utf-8").read()
NAV = re.search(r'<nav class="nav">.*?</nav>', src, re.S).group(0)
GSV = re.search(r'name="google-site-verification" content="([^"]+)"', src)
GSV = GSV.group(1) if GSV else ""

TITLE = "X Redro: Online Store for Nigerian WhatsApp & Instagram Sellers"
DESC = "Create your online store in minutes. Pick one of nine designs, add products, share one link and manage orders and payment proof in one place. Free 7-day trial."

FAQ = [
 ("What is X Redro?", "X Redro lets Nigerian sellers create an online store without building a website. You choose a design, add your products, share one link on WhatsApp or Instagram, and every order arrives in one dashboard with its payment proof and status."),
 ("Do I need a website to use it?", "No. X Redro gives you a store link to put in your Instagram bio, WhatsApp Status or broadcast. There is nothing to build or host, and no CAC registration is needed."),
 ("Can I choose how my store looks?", "Yes. There are nine store designs. You can add your logo, a banner image, a short tagline, an about section and your contact details. Anything you leave blank is simply not shown."),
 ("How do customers pay?", "Customers pay you by bank transfer, the way they already do, and upload a screenshot of the transfer with their order. X Redro does not process card payments."),
 ("How does payment verification work?", "You upload your own bank statement as a text-based PDF, and X Redro compares customers' transfer screenshots with the incoming credits on it. Anything unclear is flagged so you can check it yourself instead of guessing."),
 ("Does X Redro connect to my bank account?", "No. It never logs in to your bank. You upload your statement yourself, so you stay in control of your banking details."),
 ("How much does X Redro cost?", "You can start with a free 7-day trial. After that it is \u20a61,000 for 7 days or \u20a63,000 for 30 days."),
 ("Does it work on phones?", "Yes. Stores and the seller dashboard are designed for phones first, since most of your customers will open your link from WhatsApp or Instagram."),
]

GUIDES = [
 ("how-to-take-orders-on-whatsapp-nigeria", "How to take orders on WhatsApp in Nigeria without losing them", "A simple system for collecting customer details, payments and delivery info so no order slips through."),
 ("instagram-order-management-nigeria", "How to manage Instagram orders as a Nigerian seller", "Stop answering the same DMs all day. Set up a flow that turns interest into complete orders."),
 ("verify-bank-transfer-payments-nigeria", "How to confirm bank transfer payments and avoid fake alerts", "Why a screenshot is not proof of payment, and the checks that protect you."),
]

# ---------------- nine store illustrations ----------------
THEMES = [
 ("r1", "Neon", "Dark and techy with a controlled cyan glow", "Gadgets, gaming, tech accessories"),
 ("r2", "Minimal", "Airy, quiet and editorial", "Fashion and design-led brands"),
 ("r3", "Soft", "Friendly, rounded and approachable", "Almost any small store"),
 ("r4", "Tech", "Dark with amber badges and category tiles", "Phones, electronics, accessories"),
 ("r5", "Luxury", "Serif type, big photos, lots of space", "Boutiques, jewellery, premium fashion"),
 ("r6", "Marketplace", "Dense grid with search always open", "Stores with many products"),
 ("r7", "Listings", "Clean rows with the photo on the left", "Food, services, product lists"),
 ("r8", "Organic", "Warm, natural, round photos", "Skincare, natural and home goods"),
 ("r9", "Bold", "Loud, promotional and energetic", "Sales, promos, thrift drops"),
]

def tile(extra=""):
    return f'<span class="tm-tile {extra}"><i class="tm-img"></i><i class="tm-bar" style="width:72%"></i><b class="tm-price"></b></span>'

def mock(t, big=False):
    head = '<div class="tm-head"><i class="tm-dot"></i><b class="tm-name">Your store</b><i class="tm-cartico"></i></div>'
    if t == "r1":
        body = head + '<div class="tm-hero"><i class="tm-bar" style="width:58%"></i><i class="tm-bar" style="width:38%"></i><i class="tm-btn"></i></div><div class="tm-grid">' + tile() + tile() + '</div>'
    elif t == "r2":
        body = head + '<div class="tm-hero"><i class="tm-bar" style="width:62%"></i><i class="tm-bar" style="width:40%"></i><i class="tm-btn"></i></div><div class="tm-grid">' + tile() + tile() + '</div>'
    elif t == "r3":
        body = head + '<div class="tm-hero"><i class="tm-bar" style="width:64%"></i><i class="tm-bar" style="width:42%"></i><i class="tm-btn"></i></div><div class="tm-cats"><i></i><i></i><i></i></div><div class="tm-grid">' + tile() + tile() + (tile() + tile() if big else "") + '</div>'
    elif t == "r4":
        body = head + '<div class="tm-hero"><i class="tm-bar" style="width:60%"></i><i class="tm-bar" style="width:40%"></i><i class="tm-btn"></i></div><div class="tm-cats tm-round"><i></i><i></i><i></i></div><div class="tm-grid">' + tile("tm-badge") + tile("tm-badge") + '</div>'
    elif t == "r5":
        body = head + '<div class="tm-hero"><i class="tm-bar" style="width:56%"></i><i class="tm-bar" style="width:34%"></i><i class="tm-btn"></i></div><div class="tm-grid">' + tile() + '</div>'
    elif t == "r6":
        body = head + '<div class="tm-search"></div><div class="tm-hero"><i class="tm-bar" style="width:46%"></i></div><div class="tm-cats"><i></i><i></i><i></i></div><div class="tm-grid">' + tile() + tile() + tile() + tile() + tile() + tile() + '</div>'
    elif t == "r7":
        row = '<span class="tm-row"><i class="tm-img"></i><span><i class="tm-bar" style="width:80%"></i><i class="tm-bar" style="width:50%"></i><b class="tm-price"></b></span></span>'
        body = head + '<div class="tm-hero"><i class="tm-bar" style="width:52%"></i><i class="tm-bar" style="width:34%"></i></div><div class="tm-grid">' + row * 3 + '</div>'
    elif t == "r8":
        body = head + '<div class="tm-hero"><i class="tm-arch"></i><i class="tm-bar" style="width:50%"></i></div><div class="tm-grid">' + tile() + tile() + '</div>'
    else:
        body = '<div class="tm-announce"></div>' + head + '<div class="tm-hero"><i class="tm-bar" style="width:66%"></i><i class="tm-bar" style="width:44%"></i><i class="tm-btn"></i></div><div class="tm-grid">' + tile("tm-wide") + tile() + tile() + '</div>'
    return f'<div class="tm tm-{t}{" tm-big" if big else ""}" aria-hidden="true">{body}</div>'

def showcase():
    out = []
    for t, name, line, best in THEMES:
        out.append(f'<figure class="tslide">{mock(t)}<figcaption><b>{name}</b><span>{line}</span><small>Suits: {best}</small></figcaption></figure>')
    return "\n".join(out)

def ld(o): return '<script type="application/ld+json">' + json.dumps(o, ensure_ascii=False, separators=(",", ":")) + '</script>'
SCHEMA = [
 {"@context":"https://schema.org","@type":"Organization","name":"X Redro","url":BASE,"logo":BASE+"assets/logo-light.png",
  "contactPoint":[{"@type":"ContactPoint","contactType":"customer support","email":EMAIL,"telephone":"+2347055274048","areaServed":"NG","availableLanguage":"English"}]},
 {"@context":"https://schema.org","@type":"WebSite","name":"X Redro","url":BASE,"inLanguage":"en-NG"},
 {"@context":"https://schema.org","@type":"SoftwareApplication","name":"X Redro","applicationCategory":"BusinessApplication","operatingSystem":"Web","url":BASE,"description":DESC,"areaServed":"NG",
  "offers":[{"@type":"Offer","name":"7 days","price":"1000","priceCurrency":"NGN"},{"@type":"Offer","name":"30 days","price":"3000","priceCurrency":"NGN"}]},
 {"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":q,"acceptedAnswer":{"@type":"Answer","text":a}} for q,a in FAQ]},
]

def ic(path): return f'<svg viewBox="0 0 24 24" aria-hidden="true">{path}</svg>'
IC = {
 "store": ic('<path d="M4 9l1.5-5h13L20 9"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/>'),
 "box": ic('<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>'),
 "cart": ic('<path d="M3 4h2l2.4 11h10.2L20 8H6"/><circle cx="9" cy="19.5" r="1.4"/><circle cx="17" cy="19.5" r="1.4"/>'),
 "check": ic('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 12l2 2 4-4"/>'),
 "doc": ic('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>'),
 "status": ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
 "phone": ic('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>'),
 "user": ic('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'),
}
def feat(i, tone, t, p): return f'<article class="card feat"><div class="ico {tone}">{IC[i]}</div><h3>{t}</h3><p>{p}</p></article>'

page = f'''<!DOCTYPE html>
<html lang="en-NG">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{f'<meta name="google-site-verification" content="{GSV}">' if GSV else ''}
<title>{TITLE}</title>
<meta name="description" content="{DESC}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="geo.region" content="NG">
<meta name="geo.placename" content="Nigeria">
<meta name="theme-color" content="#F4F5F2">
<link rel="canonical" href="{BASE}">
<link rel="alternate" hreflang="en-ng" href="{BASE}">
<link rel="alternate" hreflang="x-default" href="{BASE}">
<meta property="og:site_name" content="X Redro">
<meta property="og:locale" content="en_NG">
<meta property="og:type" content="website">
<meta property="og:title" content="{TITLE}">
<meta property="og:description" content="{DESC}">
<meta property="og:url" content="{BASE}">
<meta property="og:image" content="{BASE}assets/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{TITLE}">
<meta name="twitter:description" content="{DESC}">
<meta name="twitter:image" content="{BASE}assets/og-image.png">
<link rel="icon" href="assets/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&display=swap">
<link rel="stylesheet" href="css/nav-shared.css">
<link rel="stylesheet" href="css/landing.css">
{chr(10).join(ld(s) for s in SCHEMA)}
</head>
<body>
<script>try{{var t=localStorage.getItem("theme");if(t)document.body.dataset.theme=t}}catch(e){{}}</script>
{NAV}

<main>
<section class="hero">
  <div class="wrap hero-grid">
    <div>
      <h1>Your online store for WhatsApp and Instagram sellers in Nigeria</h1>
      <p class="lede">Pick a store design, add your products and share one link. Customers browse, add to cart and send their order with payment proof. You manage everything from one dashboard.</p>
      <div class="cta-row">
        <a class="btn btn-lime" href="signup.html">Start free 7-day trial</a>
        <a class="btn btn-ghost" href="#stores">See the nine stores</a>
      </div>
      <p class="fine">No website and no CAC needed. Works on any phone.</p>
    </div>
    <div class="hero-visual">
      {mock("r3", big=True)}
      <p class="ill-note">Illustration of a store</p>
    </div>
  </div>
</section>

<section class="sec" id="stores" aria-labelledby="stores-h">
  <div class="wrap">
    <div class="sec-head"><h2 id="stores-h">Nine store designs. One is yours.</h2>
    <p class="lede">Every design is a complete store with a header, product browsing, a cart and checkout, built for phones. Each one has its own personality, so pick what fits your brand.</p></div>
  </div>
  <div class="tstrip" role="group" tabindex="0" aria-label="The nine store designs, scroll sideways">
{showcase()}
  </div>
  <div class="wrap"><p class="fine" style="margin-top:14px">Simplified illustrations. Your store shows your own products, photos, logo and banner.</p></div>
</section>

<section class="sec" id="how" aria-labelledby="how-h">
  <div class="wrap">
    <div class="sec-head"><h2 id="how-h">From idea to first order in three steps</h2></div>
    <ol class="steps">
      <li class="card"><h3>Create your store</h3><p>Choose a design, add your logo and banner, then add products with photos, prices and categories. Preview it before anyone sees it.</p></li>
      <li class="card"><h3>Share your link</h3><p>Put it in your Instagram bio, WhatsApp Status, broadcast list or TikTok profile. Customers open it right on their phones.</p></li>
      <li class="card"><h3>Manage orders</h3><p>Every order arrives with the customer's details and payment proof. Mark it Unpaid, Paid or Delivered and keep selling.</p></li>
    </ol>
  </div>
</section>

<section class="sec" aria-labelledby="problem">
  <div class="wrap">
    <div class="sec-head"><h2 id="problem">Selling in the DMs gets messy fast</h2>
    <p class="lede">The orders are coming in. The trouble is keeping track of them.</p></div>
    <div class="split">
      <div class="card"><h3>Without X Redro</h3><ul>
        <li>Scrolling through chats to find who ordered what</li>
        <li>Payment screenshots mixed in with every conversation</li>
        <li>Asking each customer for their name, address and size again</li>
        <li>"How much is the total?" asked ten times a day</li></ul></div>
      <div class="card fix"><h3>With X Redro</h3><ul>
        <li>Every order arrives complete, in one list</li>
        <li>Payment proof sits on the order it belongs to</li>
        <li>Customers fill in the details you ask for, once</li>
        <li>Totals add up on their own</li></ul></div>
    </div>
  </div>
</section>

<section class="sec" id="features" aria-labelledby="feat-h">
  <div class="wrap">
    <div class="sec-head"><h2 id="feat-h">What you get</h2></div>
    <div class="feats">
      {feat("store","i-g","A real store, not just a form","Header, search, categories, product pages, cart and checkout, in the design you choose.")}
      {feat("box","i-a","Products your way","Photos, prices, descriptions and categories. Mark favourites as Featured.")}
      {feat("cart","i-b","Cart and checkout","Customers review their cart, fill in the questions you set, and see the total add up.")}
      {feat("doc","i-g","Payment proof on every order","Customers upload their transfer screenshot with the order, so you are not hunting through chats.")}
      {feat("check","i-r","Bank statement check","Upload your text-based statement PDF and match transfer screenshots to incoming credits. Unclear ones are flagged for you.")}
      {feat("status","i-a","Order status","Mark each order Unpaid, Paid or Delivered so you always know where it stands.")}
      {feat("user","i-b","Your brand and contacts","Add a logo, banner, tagline, about text, phone, email, WhatsApp and social links.")}
      {feat("phone","i-g","Phone first","Stores and dashboard are built for the screen you already use all day.")}
    </div>
  </div>
</section>

<section class="sec" id="dashboard" aria-labelledby="dash-h">
  <div class="wrap">
    <div class="sec-head"><h2 id="dash-h">See every order at a glance</h2>
    <p class="lede">Your dashboard shows how many orders you have, which are paid and which are waiting.</p></div>
    <div class="card dash" aria-label="Sample dashboard">
      <p class="demo-tag">Demonstration data. These are not real customers or sales.</p>
      <div class="stats stats-4">
        <div class="stat s-total"><b>48</b><span>Total orders</span></div>
        <div class="stat s-deliv"><b>21</b><span>Delivered</span></div>
        <div class="stat s-paid"><b>17</b><span>Paid</span></div>
        <div class="stat s-pend"><b>10</b><span>Unpaid</span></div>
      </div>
      <div class="row"><div>Sample customer A<small>2 x Leather tote</small></div><span class="pill p-paid">Paid</span></div>
      <div class="row"><div>Sample customer B<small>1 x Oud perfume</small></div><span class="pill p-unpaid">Unpaid</span></div>
      <div class="row"><div>Sample customer C<small>3 x Satin scarf</small></div><span class="pill p-deliv">Delivered</span></div>
    </div>
  </div>
</section>

<section class="sec" id="who" aria-labelledby="who-h">
  <div class="wrap">
    <div class="sec-head"><h2 id="who-h">Built for how Nigerians sell online</h2>
    <p class="lede">If your customers find you on social media and order by message, X Redro fits.</p></div>
    <div class="chips">
      <span class="chip">Fashion and clothing</span><span class="chip">Bags and shoes</span><span class="chip">Thrift (okrika)</span>
      <span class="chip">Hair and wigs</span><span class="chip">Perfume</span><span class="chip">Skincare and beauty</span>
      <span class="chip">Gadgets</span><span class="chip">Food and cakes</span><span class="chip">Resellers and importers</span><span class="chip">Pre-order sellers</span>
    </div>
  </div>
</section>

<section class="sec" id="pricing" aria-labelledby="price-h">
  <div class="wrap">
    <div class="sec-head"><h2 id="price-h">Simple pricing in naira</h2>
    <p class="lede">Try it free for 7 days. Then pick the period that suits your selling.</p></div>
    <div class="plans">
      <div class="card plan"><h3>7 days</h3><div class="price">&#8358;1,000</div><p>Good for a single drop or a trial run.</p><a class="btn btn-ghost" href="signup.html">Start free trial</a></div>
      <div class="card plan dark"><h3>30 days</h3><div class="price">&#8358;3,000</div><p>For sellers taking orders all month.</p><a class="btn btn-lime" href="signup.html">Start free trial</a></div>
    </div>
  </div>
</section>

<section class="sec" id="faq" aria-labelledby="faq-h">
  <div class="wrap">
    <div class="sec-head"><h2 id="faq-h">Questions sellers ask</h2></div>
    <div class="faq">
{chr(10).join(f"<details><summary>{q}</summary><p>{a}</p></details>" for q, a in FAQ)}
    </div>
  </div>
</section>

<section class="sec" id="guides" aria-labelledby="guides-h">
  <div class="wrap">
    <div class="sec-head"><h2 id="guides-h">Not ready for a tool yet? Start with a guide</h2>
    <p class="lede">Free, practical guides for Nigerian sellers on taking orders, confirming payments and running pre-orders.</p></div>
    <div class="gcards">
      {"".join(f'<a class="card gcard" href="guides/{s}.html"><h3>{t}</h3><p>{d}</p><span class="more">Read guide</span></a>' for s,t,d in GUIDES)}
    </div>
    <p style="margin-top:18px"><a class="more" href="guides/">See all guides</a></p>
  </div>
</section>

<section class="sec" id="contact" aria-labelledby="contact-h">
  <div class="wrap">
    <div class="sec-head"><h2 id="contact-h">Talk to us</h2>
    <p class="lede">Questions, issues or ideas? Reach us the way that suits you.</p></div>
    <div class="contact-grid">
      <a class="card" href="mailto:{EMAIL}"><small>Email</small><b>{EMAIL}</b></a>
      <a class="card" href="{WA}" target="_blank" rel="noopener"><small>WhatsApp</small><b>Chat with us</b></a>
      <a class="card" href="{SMS}"><small>SMS</small><b>Send a text</b></a>
    </div>
  </div>
</section>

<section class="wrap">
  <div class="final">
    <h2>Your store, your link, your orders</h2>
    <p>Create your store today and try it free for 7 days.</p>
    <a class="btn btn-lime" href="signup.html">Start free trial</a>
  </div>
</section>
</main>

<footer class="foot"><div class="wrap">
  <span>&copy; 2026 X Redro. Online stores for Nigerian sellers.</span>
  <nav aria-label="Footer">
    <a href="#stores">Stores</a>
    <a href="#how">How it works</a>
    <a href="#pricing">Pricing</a>
    <a href="guides/">Guides</a>
    <a href="#contact">Contact</a>
    <a href="login.html">Log in</a>
  </nav>
</div></footer>
</body>
</html>
'''
open("index.html", "w", encoding="utf-8").write(page)

guides = sorted(os.path.basename(p) for p in glob.glob("guides/*.html") if not p.endswith("index.html"))
urls = [(BASE, "1.0"), (BASE + "guides/", "0.8")] + [(BASE + "guides/" + g, "0.7") for g in guides]
open("sitemap.xml", "w", encoding="utf-8").write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "".join(f"  <url><loc>{u}</loc><lastmod>{DATE}</lastmod><priority>{p}</priority></url>\n" for u, p in urls) + "</urlset>\n")
open("robots.txt", "w").write(f"User-agent: *\nAllow: /\nDisallow: /ng/dashboard.html\nDisallow: /ng/orders.html\nDisallow: /ng/settings.html\nDisallow: /ng/admin.html\nDisallow: /ng/design-system.html\n\nSitemap: {BASE}sitemap.xml\n")
print("built index.html,", len(guides), "guides in sitemap")
