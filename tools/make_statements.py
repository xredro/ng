#!/usr/bin/env python3
"""Builds the sample bank statements and the scenario file used by the payment verification tests.
Run from the project root:  python3 tools/fixtures/make_statements.py
Everything here is invented data. The layouts imitate common statement styles; they are not any real bank's format."""
import json, random, textwrap, os
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, letter
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import img2pdf

OUT = "tools/fixtures/statements"
random.seed(7)
os.makedirs(OUT, exist_ok=True)
scen = {}

def money(v): return f"{v:,.2f}"
def ref(n): return f"NIP/{str(9000000000000000 + n * 7919)}"

# ---------------------------------------------------------------- A: five columns, A4, 3 pages, dd/mm/yyyy
def bank_a():
    W, H = A4
    cols = {"date": (40, 112), "desc": (120, 330), "debit": (340, 402), "credit": (412, 472), "balance": (482, 556)}
    rows = []   # (date, desc, debit, credit)
    def add(d, desc, debit=None, credit=None): rows.append((d, desc, debit, credit))
    add("01/11/2026", "OPENING BALANCE")
    filler_names = ["SAMUEL ADEYEMI", "BLESSING NWOSU", "YUSUF GARBA", "FATIMA LAWAL", "EMEKA ONYEKA", "HALIMA SANI", "DAVID EKONG", "RUTH AKPAN", "KINGSLEY OBI", "TOYIN BELLO"]
    amt_pool = [1200, 2350, 3900, 5100, 6400, 8200, 9700, 13300, 14100, 21700, 26400, 33800]
    n = 0
    def filler(day):
        nonlocal n; n += 1
        who = random.choice(filler_names); amt = random.choice(amt_pool) + random.choice([0, 50, 75])
        if random.random() < 0.4: add(f"{day:02d}/11/2026", f"POS PURCHASE {random.choice(['SHOPRITE','JUMIA','FILLING STATION','PHARMACY'])} {ref(n)[-6:]}", debit=float(amt))
        else: add(f"{day:02d}/11/2026", f"TRF FROM {who} {ref(n)}", credit=float(amt))
    for d in (2, 3, 4, 5, 6, 7, 8, 9): 
        for _ in range(3): filler(d)
    # --- the cases the tests care about
    add("10/11/2026", f"TRF FROM JOHN DOE {ref(101)}", credit=15000.00)                          # confident
    add("10/11/2026", "POS PURCHASE SHOPRITE LEKKI", debit=30000.00)                              # debit equal to an order total
    add("10/11/2026", f"NIP TRANSFER FROM JOHN DOE {ref(102)}", credit=22500.00)                  # similar names
    add("10/11/2026", f"NIP TRANSFER FROM JOHN DOE JR {ref(103)}", credit=22500.00)
    add("11/11/2026", f"MARY JANE ADAMS NIP {ref(104)}", credit=7500.00)                           # identical amounts, different names
    add("11/11/2026", f"PETER OKONKWO NIP {ref(105)}", credit=7500.00)
    add("11/11/2026", f"TRF FROM TUNDE BAKARE {ref(106)}", credit=18000.00)                       # customer date 2 days earlier
    add("11/11/2026", f"TRF FROM NGOZI EZE {ref(107)}", credit=16000.00)                           # customer date 10 days earlier
    add("11/11/2026", f"FUND TRANSFER {ref(108)} FROM SOMEONE ELSE", credit=5500.00)               # amount only, no name or date
    add("12/11/2026", "TRANSFER FROM CHINEDU EMMANUEL OBIORA /INTERBANK PAYMENT FOR GOODS /REF 55120987", credit=48000.00)   # wrapped description
    add("12/11/2026", f"TRF FROM AMINA BELLO {ref(110)}", credit=9000.00)                          # duplicate-looking pair
    add("12/11/2026", f"TRF FROM AMINA BELLO {ref(110)}", credit=9000.00)
    add("12/11/2026", f"TRF FROM FUNMI ALADE {ref(111)}", credit=25400.00)
    add("13/11/2026", f"DEPOSIT {ref(112)} KAYODE JOHNSON", credit=11250.00)
    for d in (13, 13, 14, 14): filler(d)
    add("14/11/2026", f"WEB PAYMENT HALIMA SANI {ref(113)}", credit=6000.00)
    pages_rows = []
    # lay out
    c = canvas.Canvas(f"{OUT}/bankA_clean.pdf", pagesize=A4)
    y = H - 60; page = 1; line_h = 11; sched = []
    def header(first):
        nonlocal y
        c.setFont("Helvetica-Bold", 12); c.drawString(40, H - 38, "SAMPLE BANK PLC  -  ACCOUNT STATEMENT"); c.setFont("Helvetica", 8)
        c.drawString(40, H - 50, f"Account: 0123456789   Period: 01/11/2026 - 14/11/2026   Page {page}")
        if first:
            c.drawString(40, H - 62, "Opening balance 500,000.00"); c.drawRightString(cols["credit"][1] - 2, H - 62, "Total credits 1,234,567.00"); c.drawRightString(cols["balance"][1] - 2, H - 62, "Closing 25,400.00")
            y = H - 84
        else: y = H - 70
        c.setFont("Helvetica-Bold", 8)
        c.drawString(cols["date"][0] + 2, y, "DATE"); c.drawString(cols["desc"][0] + 2, y, "DESCRIPTION"); c.drawRightString(cols["debit"][1] - 2, y, "DEBIT"); c.drawRightString(cols["credit"][1] - 2, y, "CREDIT"); c.drawRightString(cols["balance"][1] - 2, y, "BALANCE")
        c.setFont("Helvetica", 8); y -= 16
    header(True); bal = 500000.00
    for (d, desc, debit, credit) in rows:
        lines = textwrap.wrap(desc, 36) or [desc]
        need = len(lines) * line_h + 6
        if y - need < 50:
            c.showPage(); page += 1; header(False)
        if debit: bal -= debit
        if credit: bal += credit
        if desc == "TRANSFER FROM FUNMI ALADE": pass
        c.drawString(cols["date"][0] + 2, y, d)
        for i, ln in enumerate(lines): c.drawString(cols["desc"][0] + 2, y - i * line_h, ln)
        if debit: c.drawRightString(cols["debit"][1] - 2, y, money(debit))
        if credit: c.drawRightString(cols["credit"][1] - 2, y, money(credit))
        c.drawRightString(cols["balance"][1] - 2, y, money(bal))
        y -= need
    c.save()
    frac = lambda k: {"x0": round((cols[k][0]) / W, 4), "x1": round((cols[k][1]) / W, 4)}
    layout = {"mode": "three", "regions": {"date": frac("date"), "desc": frac("desc"), "credit": frac("credit")}}
    orders = [
        {"id": "O1", "name": "John Doe", "date": "2026-11-10", "total": 15000, "expect": "confident", "why": "name, date and amount all agree"},
        {"id": "O2", "name": "John Doe", "date": "2026-11-10", "total": 22500, "expect": "review", "why": "John Doe and John Doe Jr are both plausible"},
        {"id": "O3", "name": "John Doe Jr", "date": "2026-11-10", "total": 22500, "expect": "review", "why": "similar names, same amount"},
        {"id": "O4", "name": "Mary Jane Adams", "date": "2026-11-11", "total": 7500, "expect": "confident", "why": "identical amount, distinct names"},
        {"id": "O5", "name": "Peter Okonkwo", "date": "2026-11-11", "total": 7500, "expect": "confident", "why": "identical amount, distinct names"},
        {"id": "O6", "name": "Tunde Bakare", "date": "2026-11-09", "total": 18000, "expect": "review", "why": "date is 2 days off"},
        {"id": "O7", "name": "Ngozi Eze", "date": "2026-11-01", "total": 16000, "expect": "review", "why": "name and amount match, date is 10 days off"},
        {"id": "O8", "name": "Wrong Person", "date": "2026-11-01", "total": 5500, "expect": "unmatched", "why": "amount only"},
        {"id": "O9", "name": "Chinedu Emmanuel Obiora", "date": "2026-11-12", "total": 48000, "expect": "confident", "why": "wrapped description"},
        {"id": "O10", "name": "Amina Bello", "date": "2026-11-12", "total": 9000, "expect": "review", "why": "two identical-looking transactions"},
        {"id": "O11", "name": "Amina Bello", "date": "2026-11-12", "total": 9000, "expect": "review", "why": "two identical-looking transactions"},
        {"id": "O12", "name": "Grace Ade", "date": "2026-11-10", "total": 30000, "expect": "unmatched", "why": "the 30,000.00 on the statement is a DEBIT"},
        {"id": "O13", "name": "Funmi Alade", "date": "2026-11-12", "total": 25400, "expect": "confident", "why": "25,400.00 is also the closing balance figure in the page header; only the credit counts"},
        {"id": "O14", "name": "Kayode Johnson", "date": "2026-11-13", "total": 11250, "expect": "confident", "why": "name after the word DEPOSIT"},
        {"id": "O15", "name": "Halima Sani", "date": "2026-11-14", "total": 6000, "expect": "confident", "why": "late row, page 3"},
        {"id": "O16", "name": "Ibrahim Lawal", "date": "2026-11-10", "total": 1234567, "expect": "unmatched", "why": "equals the 'Total credits' text in the page summary, which is not a transaction"},
    ]
    scen["bankA_clean"] = {"pdf": "bankA_clean.pdf", "layout": layout, "orders": orders, "pages": page, "note": "5 columns, dd/mm/yyyy (13+ days present so the order is provable), debit and credit columns, wrapped descriptions, summary text above the table"}

# ---------------------------------------------------------------- B: combined date+details column, one amount column with CR/DR, Letter, 2 pages
def bank_b():
    W, H = letter
    cols = {"details": (30, 330), "amount": (380, 470), "balance": (490, 585)}
    tx = [
        ("10 Nov 2026 09:14", "FROM IBRAHIM MUSA /NIP/ PAYMENT", 11000.00, "CR"),
        ("10 Nov 2026 10:02", "ATM WITHDRAWAL IKEJA CITY MALL", 7000.00, "DR"),
        ("10 Nov 2026 12:40", "FROM FUNKE ALADE / HOUSE OF FUNKE / INTERBANK TRANSFER FOR ORDER", 13000.00, "CR"),
        ("11 Nov 2026 08:05", "AIRTIME PURCHASE 0803XXXX", 2000.00, "DR"),
        ("11 Nov 2026 15:33", "FROM CHIDI NWANKWO", 18000.00, "CR"),
        ("11 Nov 2026 16:21", "FROM HAUWA SULEIMAN", 18000.00, "CR"),
        ("12 Nov 2026 11:11", "CHARGES: SMS ALERT", 52.50, "DR"),
        ("12 Nov 2026 14:50", "FROM OLUWASEUN FALANA", 9500.00, "CR"),
        ("13 Nov 2026 09:00", "TRANSFER TO LANDLORD", 9500.00, "DR"),
        ("13 Nov 2026 17:45", "FROM BOLA TINUBU-ADE", 4300.00, "CR"),
    ]
    c = canvas.Canvas(f"{OUT}/bankB_combined.pdf", pagesize=letter)
    y = H - 40; line_h = 11; bal = 80000.00
    c.setFont("Helvetica-Bold", 11); c.drawString(30, H - 30, "SAMPLE MFB  -  STATEMENT OF ACCOUNT"); c.setFont("Helvetica-Bold", 8); y = H - 62
    c.drawString(cols["details"][0] + 2, y, "TRANSACTION DETAILS"); c.drawRightString(cols["amount"][1] - 2, y, "AMOUNT"); c.drawRightString(cols["balance"][1] - 2, y, "BALANCE"); c.setFont("Helvetica", 8); y -= 18
    for (d, desc, amt, cr) in tx:
        lines = textwrap.wrap(desc, 52)
        need = (len(lines) + 1) * line_h + 8
        bal += amt if cr == "CR" else -amt
        c.drawString(cols["details"][0] + 2, y, d)
        for i, ln in enumerate(lines): c.drawString(cols["details"][0] + 2, y - (i + 1) * line_h, ln)
        c.drawRightString(cols["amount"][1] - 2, y, f"{money(amt)} {cr}"); c.drawRightString(cols["balance"][1] - 2, y, money(bal))
        y -= need
    c.showPage()
    c.setFont("Helvetica-Bold", 8); c.drawString(30, H - 30, "SAMPLE MFB  -  STATEMENT OF ACCOUNT (continued)"); y = H - 62
    c.drawString(cols["details"][0] + 2, y, "TRANSACTION DETAILS"); c.drawRightString(cols["amount"][1] - 2, y, "AMOUNT"); c.drawRightString(cols["balance"][1] - 2, y, "BALANCE"); c.setFont("Helvetica", 8); y -= 18
    for (d, desc, amt, cr) in [("14 Nov 2026 10:10", "FROM TEMITOPE AJAYI", 12600.00, "CR"), ("14 Nov 2026 10:12", "FROM TEMITOPE AJAYI", 12600.00, "CR")]:
        bal += amt
        c.drawString(cols["details"][0] + 2, y, d); c.drawString(cols["details"][0] + 2, y - line_h, desc)
        c.drawRightString(cols["amount"][1] - 2, y, f"{money(amt)} {cr}"); c.drawRightString(cols["balance"][1] - 2, y, money(bal)); y -= 2 * line_h + 8
    c.save()
    frac = lambda k: {"x0": round(cols[k][0] / W, 4), "x1": round(cols[k][1] / W, 4)}
    layout = {"mode": "two", "regions": {"namedate": frac("details"), "credit": frac("amount")}}
    orders = [
        {"id": "B1", "name": "Ibrahim Musa", "date": "2026-11-10", "total": 11000, "expect": "confident", "why": "combined column, CR suffix"},
        {"id": "B2", "name": "Funke Alade", "date": "2026-11-10", "total": 13000, "expect": "confident", "why": "wrapped details"},
        {"id": "B3", "name": "Chidi Nwankwo", "date": "2026-11-11", "total": 18000, "expect": "confident", "why": "same amount as another credit, different name"},
        {"id": "B4", "name": "Hauwa Suleiman", "date": "2026-11-11", "total": 18000, "expect": "confident", "why": "same amount as another credit, different name"},
        {"id": "B5", "name": "Landlord Ade", "date": "2026-11-13", "total": 9500, "expect": "unmatched", "why": "9,500.00 appears as a DR"},
        {"id": "B6", "name": "Oluwaseun Falana", "date": "2026-11-12", "total": 9500, "expect": "confident", "why": "its own credit of 9,500.00; the DR of 9,500.00 must not count"},
        {"id": "B7", "name": "Temitope Ajayi", "date": "2026-11-14", "total": 12600, "expect": "review", "why": "two identical-looking credits"},
    ]
    scen["bankB_combined"] = {"pdf": "bankB_combined.pdf", "layout": layout, "orders": orders, "pages": 2, "note": "date and description share a column; one amount column marked CR/DR; dates like '10 Nov 2026 09:14'; Letter page"}

# ---------------------------------------------------------------- C: ISO dates, signed amounts in one column, A4, 1 page
def bank_c():
    W, H = A4
    cols = {"date": (40, 110), "desc": (125, 345), "amount": (360, 440), "balance": (460, 555)}
    tx = [("2026-11-10", "NIP TRANSFER FROM EMEKA OKORO", 15000.00), ("2026-11-10", "POS SPAR SURULERE", -4500.00), ("2026-11-11", "NIP TRANSFER FROM ADAEZE OKORO", 15000.00),
          ("2026-11-11", "USSD TRANSFER FROM RASHEED LAWAL", 3200.00), ("2026-11-12", "BILL PAYMENT DSTV", -9000.00), ("2026-11-12", "NIP TRANSFER FROM CHRISTIANA UCHE", 9000.00)]
    c = canvas.Canvas(f"{OUT}/bankC_iso.pdf", pagesize=A4)
    c.setFont("Helvetica-Bold", 11); c.drawString(40, H - 40, "SAMPLE DIGITAL BANK"); c.setFont("Helvetica-Bold", 8); y = H - 70
    c.drawString(cols["date"][0] + 2, y, "Date"); c.drawString(cols["desc"][0] + 2, y, "Narration"); c.drawRightString(cols["amount"][1] - 2, y, "Amount"); c.drawRightString(cols["balance"][1] - 2, y, "Balance"); c.setFont("Helvetica", 8); y -= 16
    bal = 100000.0
    for d, desc, amt in tx:
        bal += amt
        c.drawString(cols["date"][0] + 2, y, d); c.drawString(cols["desc"][0] + 2, y, desc)
        c.drawRightString(cols["amount"][1] - 2, y, ("+" if amt > 0 else "-") + money(abs(amt))); c.drawRightString(cols["balance"][1] - 2, y, money(bal)); y -= 18
    c.save()
    frac = lambda k: {"x0": round(cols[k][0] / W, 4), "x1": round(cols[k][1] / W, 4)}
    layout = {"mode": "three", "regions": {"date": frac("date"), "desc": frac("desc"), "credit": frac("amount")}}
    orders = [
        {"id": "C1", "name": "Emeka Okoro", "date": "2026-11-10", "total": 15000, "expect": "confident", "why": "ISO dates, signed amounts"},
        {"id": "C2", "name": "Adaeze Okoro", "date": "2026-11-11", "total": 15000, "expect": "confident", "why": "same amount, same surname, different first name and day"},
        {"id": "C3", "name": "Rasheed Lawal", "date": "2026-11-11", "total": 3200, "expect": "confident", "why": "plain credit"},
        {"id": "C4", "name": "Dstv Customer", "date": "2026-11-12", "total": 9000, "expect": "unmatched", "why": "the 9,000.00 is a debit (-9,000.00)... but another credit of 9,000.00 exists, see C5"},
        {"id": "C5", "name": "Christiana Uche", "date": "2026-11-12", "total": 9000, "expect": "confident", "why": "its own credit; the debit of the same amount must be ignored"},
    ]
    scen["bankC_iso"] = {"pdf": "bankC_iso.pdf", "layout": layout, "orders": orders, "pages": 1, "note": "ISO dates; one signed amount column (+credit, -debit)"}

# ---------------------------------------------------------------- D: dd/mm/yyyy where every day is 12 or less (the order cannot be proven)
def bank_d():
    W, H = A4
    cols = {"date": (40, 112), "desc": (120, 330), "debit": (340, 402), "credit": (412, 472), "balance": (482, 556)}
    tx = [("05/11/2026", "TRF FROM LATEEF ADEWALE", 14000.00), ("06/11/2026", "TRF FROM CAROLINE EKE", 8800.00), ("02/11/2026", "TRF FROM LATEEF ADEWALE", 14000.00)]
    c = canvas.Canvas(f"{OUT}/bankD_ambiguous.pdf", pagesize=A4)
    c.setFont("Helvetica-Bold", 8); y = H - 70
    c.drawString(cols["date"][0] + 2, y, "DATE"); c.drawString(cols["desc"][0] + 2, y, "DESCRIPTION"); c.drawRightString(cols["debit"][1] - 2, y, "DEBIT"); c.drawRightString(cols["credit"][1] - 2, y, "CREDIT"); c.drawRightString(cols["balance"][1] - 2, y, "BALANCE"); c.setFont("Helvetica", 8); y -= 16
    bal = 50000.0
    for d, desc, amt in tx:
        bal += amt; c.drawString(cols["date"][0] + 2, y, d); c.drawString(cols["desc"][0] + 2, y, desc); c.drawRightString(cols["credit"][1] - 2, y, money(amt)); c.drawRightString(cols["balance"][1] - 2, y, money(bal)); y -= 16
    c.save()
    frac = lambda k: {"x0": round(cols[k][0] / W, 4), "x1": round(cols[k][1] / W, 4)}
    layout = {"mode": "three", "regions": {"date": frac("date"), "desc": frac("desc"), "credit": frac("credit")}}
    orders = [
        {"id": "D1", "name": "Caroline Eke", "date": "2026-11-06", "total": 8800, "expect": "review", "why": "06/11/2026 could be 6 Nov or 11 Jun; nothing in the statement settles it"},
        {"id": "D2", "name": "Lateef Adewale", "date": "2026-11-05", "total": 14000, "expect": "review", "why": "two rows of 14,000; one on 05/11 (ambiguous) and 02/11"},
    ]
    scen["bankD_ambiguous"] = {"pdf": "bankD_ambiguous.pdf", "layout": layout, "orders": orders, "pages": 1, "note": "every date has a day of 12 or less, so day-first can't be proven"}

bank_a(); bank_b(); bank_c(); bank_d()

# ---------------------------------------------------------------- unsupported documents (must be rejected, never read)
def unsupported():
    # 1. an image-only PDF: a picture of a statement, no text layer at all
    W, H = 1240, 1754
    img = Image.new("L", (W, H), 255); d = ImageDraw.Draw(img)
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 24); bold = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 24)
    d.text((80, 60), "SAMPLE BANK PLC   ACCOUNT STATEMENT", font=bold, fill=0)
    y = 160
    for x, label in ((80, "DATE"), (330, "DESCRIPTION"), (820, "DEBIT"), (980, "CREDIT")): d.text((x, y), label, font=bold, fill=0)
    y += 50
    for dt, desc, cr in (("10/11/2026", "TRF FROM JOHN DOE", "15,000.00"), ("11/11/2026", "TRF FROM MARY ADAMS", "7,500.00"), ("12/11/2026", "TRF FROM CHINEDU OBIORA", "48,000.00")):
        d.text((80, y), dt, font=font, fill=0); d.text((330, y), desc, font=font, fill=0); d.text((980, y), cr, font=font, fill=0); y += 56
    img = img.filter(ImageFilter.GaussianBlur(0.7)); img.save(f"{OUT}/image_only_page.png")
    with open(f"{OUT}/image_only.pdf", "wb") as f: f.write(img2pdf.convert(f"{OUT}/image_only_page.png", layout_fun=img2pdf.get_layout_fun((img2pdf.mm_to_pt(210), img2pdf.mm_to_pt(297)))))
    # 2. a text PDF with almost no text (a cover page): not a statement
    c = canvas.Canvas(f"{OUT}/tiny_text.pdf", pagesize=A4); c.setFont("Helvetica", 12); c.drawString(100, 700, "Statement enclosed"); c.drawString(100, 680, "Thank you"); c.save()
    # 3. a text PDF with words but no figures at all
    c = canvas.Canvas(f"{OUT}/no_figures.pdf", pagesize=A4); c.setFont("Helvetica", 10)
    for i, w in enumerate("Dear customer please find your statement attached to this letter. We value your business and hope to serve you again soon. Kind regards from the team.".split(" ")): c.drawString(60 + (i % 6) * 80, 760 - (i // 6) * 14, w)
    c.save()
    scen["_unsupported"] = [{"pdf": "image_only.pdf", "why": "image-only PDF: a photograph or scan saved as a PDF"}, {"pdf": "tiny_text.pdf", "why": "almost no text"}, {"pdf": "no_figures.pdf", "why": "words but no amounts or dates"}]

unsupported()
json.dump(scen, open(f"{OUT}/scenarios.json", "w"), indent=1)
print({k: (v["pages"] if isinstance(v, dict) else len(v)) for k, v in scen.items()})
