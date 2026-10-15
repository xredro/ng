/* X-Redro manual PDF payment verification workspace.
   The statement is displayed as the original PDF. Search suggestions are clues only;
   the seller must inspect the statement and proof before confirming an order. */
const VERIFY_DB_ID = "695c4fce0039f513dc83";
const VERIFY_ORDERS = "orders";
const VERIFY_BUCKET = "696825350032fe17c1eb";
const VERIFY_PROJECT = "695981480033c7a4eb0d";
let verifyWorkspace = null;

function createVerifyWorkspaceState() {
  return { pdf:null, fileBuffer:null, pages:[], orders:[], currentIndex:0, currentCandidateIndex:0, viewPage:1, manualCandidate:null, manualOrderId:null,
    candidatesByOrder:new Map(), reviewed:new Set(), skipped:new Set(), usedTransactions:new Set(),
    sellerId:null, zoom:1, baseFitScale:1, renderToken:0, proofOpen:false, dateWindow:2, busy:false, resizeTimer:null };
}
function ensureVerifyOverlay() {
  if (document.getElementById('verifyOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id='verifyOverlay'; overlay.className='verify-overlay hidden';
  overlay.innerHTML='<div class="verify-panel verify-workspace-panel"><button class="verify-close" aria-label="Close" onclick="closeVerifyOverlay()">&times;</button><div id="verifyBody"></div></div>';
  document.body.appendChild(overlay);
}
function openVerifyOverlay() {
  ensureVerifyOverlay();
  verifyWorkspace=createVerifyWorkspaceState();
  document.getElementById('verifyOverlay').classList.remove('hidden');
  renderVerifyStart();
}
function closeVerifyOverlay() {
  const overlay=document.getElementById('verifyOverlay'); if(overlay) overlay.classList.add('hidden');
  if(verifyWorkspace) { verifyWorkspace.renderToken++; verifyWorkspace.pdf=null; }
}
function verifyEscape(value) { return String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function verifyParseFormData(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(v=>{try{return typeof v==='string'?JSON.parse(v):v;}catch{return null;}}).filter(Boolean);
}
function verifyPaymentFields(order) {
  const data=verifyParseFormData(order.formData);
  const get=(types, labels=[])=>data.find(x=>types.includes(String(x.type||'').toLowerCase()) || labels.includes(String(x.label||'').toLowerCase()))?.value;
  return {
    name:String(get(['payment_account_name','paymentaccountname'],['name on payment','account name used for payment'])||'').trim(),
    date:String(get(['payment_date','date_paid','paymentdate'],['date paid','payment date'])||'').trim()
  };
}
function verifyMoney(value) {
  if (typeof value==='number') return Math.round(value*100)/100;
  const s=String(value??'').replace(/,/g,'').replace(/[^\d.()-]/g,'').replace(/[()]/g,'');
  const n=Number(s); return Number.isFinite(n)?Math.round(n*100)/100:null;
}
function verifyDate(value) {
  if (!value) return null;
  const s=String(value).trim();
  let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d=new Date(`${s}T12:00:00`);
  else {
    const m=s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
    if(m) { let y=Number(m[3]); if(y<100)y+=2000; d=new Date(y,Number(m[2])-1,Number(m[1]),12); }
    else d=new Date(s);
  }
  return Number.isNaN(d.getTime())?null:d;
}
function verifyNormText(s) { return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function verifyAmountTokens(text) {
  const out=[]; const re=/(?:₦|NGN\s*)?\s*\(?\s*\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s*\)?/gi; let m;
  while((m=re.exec(String(text||'')))!==null){const n=verifyMoney(m[0]); if(n!==null && n>0)out.push(n);} return out;
}
function verifyFindDates(text) {
  const out=[]; const re=/\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4})\b/g; let m;
  while((m=re.exec(String(text||'')))!==null){const d=verifyDate(m[0]); if(d)out.push({raw:m[0],date:d});} return out;
}
function verifyNameScore(name, text) {
  const tokens=verifyNormText(name).split(' ').filter(t=>t.length>1 && !['mr','mrs','miss','ms'].includes(t));
  if(!tokens.length)return 0;
  const hay=verifyNormText(text); let hits=0;
  tokens.forEach(t=>{if(hay.includes(t))hits++;});
  if(hits===tokens.length)return 30;
  if(hits>=2)return 20;
  if(hits===1)return 9;
  return 0;
}
function renderVerifyStart() {
  const body=document.getElementById('verifyBody');
  body.innerHTML=`<div class="verify-start-screen"><h2>Verify Payments</h2><p class="verify-sub">Upload your bank statement once. X-Redro will display the original PDF, jump to likely transactions and show each customer's payment proof beside it. You confirm every payment manually.</p><div class="verify-upload"><input id="verifyStatementFile" type="file" accept="application/pdf" hidden onchange="handleStatementUpload(this)"><label for="verifyStatementFile" class="verify-upload-ui"><span class="upload-icon">↑</span><strong>Choose bank statement PDF</strong><small>Searchable PDFs work best. Scanned statements can still be browsed manually.</small></label></div><div id="verifyStatementStatus" class="verify-status-line"></div><p class="verify-privacy-note">The PDF is read in this browser and is not uploaded to X-Redro's servers.</p></div>`;
}
async function handleStatementUpload(input) {
  const file=input.files?.[0]; if(!file)return;
  const body=document.getElementById('verifyBody'); body.innerHTML='<h2>Opening bank statement…</h2><p class="verify-sub">Loading PDF pages and preparing payment suggestions.</p><div class="verify-loader"></div>';
  try {
    if(!window.pdfjsLib) throw new Error('The PDF viewer library did not load. Refresh the page and try again.');
    const buffer=await file.arrayBuffer();
    if(new TextDecoder().decode(buffer.slice(0,5))!=='%PDF-') throw new Error('This file does not appear to be a valid PDF.');
    verifyWorkspace.fileBuffer=buffer;
    verifyWorkspace.pdf=await pdfjsLib.getDocument({data:buffer}).promise;
    await extractVerifyPdfText();
    await loadVerifyOrders();
    buildVerifySuggestions();
    renderVerifyViewer();
    const first=nextVerifyOrderIndex(-1);
    if(first>=0){verifyWorkspace.currentIndex=first;verifyWorkspace.currentCandidateIndex=0;renderVerifyViewer();}
    else renderVerifyEmptyOrders();
  } catch(err) {
    console.error('Manual payment verification failed to load:',err);
    body.innerHTML=`<h2>Could not open statement</h2><div class="verify-error">${verifyEscape(err.message||'The PDF could not be opened.')}</div><button class="verify-btn-primary" onclick="renderVerifyStart()">Try again</button>`;
  }
}
async function extractVerifyPdfText() {
  const state=verifyWorkspace; state.pages=[];
  for(let pageNo=1;pageNo<=state.pdf.numPages;pageNo++){
    const page=await state.pdf.getPage(pageNo); const content=await page.getTextContent({disableCombineTextItems:false});
    const items=content.items.filter(i=>i.str && i.str.trim()).map(i=>({text:i.str,x:i.transform?.[4]||0,y:i.transform?.[5]||0,width:i.width||0,height:Math.abs(i.transform?.[3]||10)}));
    const lines=[];
    items.slice().sort((a,b)=>b.y-a.y||a.x-b.x).forEach(item=>{
      let line=lines.find(l=>Math.abs(l.y-item.y)<3.8);
      if(!line){line={y:item.y,items:[]};lines.push(line);} line.items.push(item);
    });
    lines.forEach(l=>{l.items.sort((a,b)=>a.x-b.x);l.text=l.items.map(i=>i.text).join(' ').replace(/\s+/g,' ').trim();});
    lines.sort((a,b)=>b.y-a.y);
    state.pages.push({pageNo, page, items, lines, text:lines.map(l=>l.text).join('\n')});
  }
}
async function loadVerifyOrders() {
  let orders=Array.isArray(allOrders)?allOrders.slice():[];
  // Refresh from Appwrite so this workspace does not rely on a stale Orders-page list.
  if(typeof user!=='undefined' && user?.$id){
    try {
      const fresh=[]; let offset=0; let page=[];
      do {
        const result=await databases.listDocuments(DB_ID,ORDERS,[Query.equal('userId',user.$id),Query.orderDesc('$createdAt'),Query.limit(100),Query.offset(offset)]);
        page=result.documents||[]; fresh.push(...page); offset+=page.length;
      } while(page.length===100);
      orders=fresh; verifyWorkspace.sellerId=user.$id;
    } catch(e){console.warn('Could not refresh orders before verification; using currently loaded orders.',e);verifyWorkspace.sellerId=user.$id||'seller';}
  }
  verifyWorkspace.orders=orders.filter(o=>o.status==='pending' && o.paymentProof);
  const key=`xredro-used-transactions-${verifyWorkspace.sellerId||'seller'}`;
  try{verifyWorkspace.usedTransactions=new Set(JSON.parse(localStorage.getItem(key)||'[]'));}catch{verifyWorkspace.usedTransactions=new Set();}
}
function buildVerifySuggestions() {
  const state=verifyWorkspace; state.candidatesByOrder.clear();
  state.orders.forEach(order=>{
    const fields=verifyPaymentFields(order); const amount=verifyMoney(order.totalAmount); const paidDate=verifyDate(fields.date); const candidates=[];
    if(amount!==null){
      state.pages.forEach(pg=>{
        pg.lines.forEach((line,idx)=>{
          const amounts=verifyAmountTokens(line.text); if(!amounts.some(n=>Math.abs(n-amount)<0.011))return;
          // Bank statements often put date/name/credit on one visual line, but
          // allow adjacent lines to carry a wrapped description or date.
          const related=pg.lines.slice(Math.max(0,idx-2),Math.min(pg.lines.length,idx+3));
          const context=related.map(l=>l.text).join(' | ');
          const nameScore=verifyNameScore(fields.name,context);
          const dates=verifyFindDates(context);
          let dateScore=0, dateDistance=null, dateText='';
          if(paidDate && dates.length){
            dates.forEach(found=>{const days=Math.abs((found.date.setHours(12,0,0,0)-new Date(paidDate).setHours(12,0,0,0))/86400000); if(dateDistance===null||days<dateDistance){dateDistance=days;dateText=found.raw;}});
            if(dateDistance<=state.dateWindow) dateScore=Math.max(0,22-dateDistance*5);
            else return;
          } else if(paidDate && !dates.length) dateScore=0;
          const score=55+nameScore+dateScore;
          const fingerprint=[pg.pageNo,Math.round(line.y),amount,verifyNormText(line.text)].join('|');
          if(state.usedTransactions.has(fingerprint))return;
          candidates.push({pageNo:pg.pageNo,y:line.y,lineText:line.text,context,amount,score,nameScore,dateScore,dateText,fingerprint,lineIndex:idx});
        });
      });
    }
    candidates.sort((a,b)=>b.score-a.score||a.pageNo-b.pageNo||b.y-a.y);
    // Remove duplicate suggestions for the same visual transaction/line group.
    const unique=[]; candidates.forEach(c=>{if(!unique.some(u=>u.pageNo===c.pageNo&&Math.abs(u.y-c.y)<13))unique.push(c);});
    state.candidatesByOrder.set(order.$id,unique);
  });
}
function nextVerifyOrderIndex(from) {
  const state=verifyWorkspace;
  for(let i=from+1;i<state.orders.length;i++){
    if(state.reviewed.has(state.orders[i].$id)||state.skipped.has(state.orders[i].$id))continue;
    const c=state.candidatesByOrder.get(state.orders[i].$id)||[];
    if(c.length)return i;
  }
  // Keep unmatched orders reachable after the suggested matches.
  for(let i=from+1;i<state.orders.length;i++) if(!state.reviewed.has(state.orders[i].$id)&&!state.skipped.has(state.orders[i].$id)) return i;
  for(let i=0;i<=Math.min(from,state.orders.length-1);i++) if(!state.reviewed.has(state.orders[i].$id)&&!state.skipped.has(state.orders[i].$id))return i;
  return -1;
}
function renderVerifyEmptyOrders() {
  document.getElementById('verifyBody').innerHTML=`<h2>Statement opened</h2><p class="verify-sub">There are no unpaid orders with payment proof images available to verify. You can close this workspace and return to Orders.</p><button class="verify-btn-primary" onclick="closeVerifyOverlay()">Done</button>`;
}
function renderVerifyViewer() {
  const state=verifyWorkspace, body=document.getElementById('verifyBody'); if(!state||!body)return;
  if(!state.orders.length){renderVerifyEmptyOrders();return;}
  const order=state.orders[state.currentIndex]; if(!order){renderVerifyEmptyOrders();return;}
  const candidates=state.candidatesByOrder.get(order.$id)||[];
  state.currentCandidateIndex=Math.min(state.currentCandidateIndex,Math.max(0,candidates.length-1));
  const suggestedCandidate=candidates[state.currentCandidateIndex]||null;
  const candidate=state.manualOrderId===order.$id && state.manualCandidate ? state.manualCandidate : suggestedCandidate;
  state.viewPage=candidate?.pageNo||state.viewPage||1;
  const fields=verifyPaymentFields(order); const reviewed=state.reviewed.size+state.skipped.size; const amount=verifyMoney(order.totalAmount);
  const pageNo=candidate?.pageNo||1;
  body.innerHTML=`<div class="verify-workspace-head"><div class="verify-title-row"><h2>Payment verification</h2><p>Reviewed ${reviewed} of ${state.orders.length}</p></div><div class="verify-progress-track"><span style="width:${Math.min(100,reviewed/Math.max(1,state.orders.length)*100)}%"></span></div></div>
    <div class="verify-order-compact"><div><small>Order</small><strong>${verifyEscape(order.$id)}</strong></div><div><small>Customer</small><strong>${verifyEscape(verifyCustomerName(order))}</strong></div><div><small>Amount</small><strong>${amount===null?'—':'₦'+amount.toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></div><button type="button" class="verify-details-toggle" onclick="toggleVerifyDetails()" aria-expanded="false" id="verifyDetailsToggle">Details ▾</button></div>
    <div class="verify-order-details hidden" id="verifyOrderDetails"><div><small>Name on payment</small><strong>${verifyEscape(fields.name||'Not provided')}</strong></div><div><small>Date paid</small><strong>${verifyEscape(fields.date||'Not provided')}</strong></div><label class="verify-date-window">Date range <select id="verifyDateWindow" onchange="changeVerifyDateWindow(this.value)"><option value="0" ${state.dateWindow===0?'selected':''}>Same day</option><option value="1" ${state.dateWindow===1?'selected':''}>± 24 hours</option><option value="2" ${state.dateWindow===2?'selected':''}>± 2 days</option><option value="3" ${state.dateWindow===3?'selected':''}>± 3 days</option><option value="7" ${state.dateWindow===7?'selected':''}>± 7 days</option><option value="99" ${state.dateWindow===99?'selected':''}>Any date</option></select></label></div>
    <div id="verifyMatchStatus" class="verify-match-status ${candidate?'':'no-match'}">${candidate?(candidate.manual?`Manual location selected · Page ${candidate.pageNo}`:`Suggested transaction ${state.currentCandidateIndex+1} of ${candidates.length} · Page ${candidate.pageNo} of ${state.pdf.numPages}`):'No likely transaction found. Scroll the statement and tap a transaction line to select it manually, or widen the date range in Details.'}</div>
    <div class="verify-pdf-toolbar"><div class="verify-pdf-file-label">Bank statement · ${state.pdf.numPages} pages</div><div class="verify-pdf-controls"><button type="button" onclick="verifyPrevPage()" aria-label="Previous page">‹</button><span id="verifyPageLabel">Page ${pageNo} / ${state.pdf.numPages}</span><button type="button" onclick="verifyNextPage()" aria-label="Next page">›</button><span class="verify-toolbar-divider"></span><button type="button" onclick="changeVerifyZoom(-0.15)" aria-label="Zoom out">−</button><span id="verifyZoomLabel">Fit width</span><button type="button" onclick="changeVerifyZoom(0.15)" aria-label="Zoom in">+</button><button type="button" class="verify-fit-button" onclick="fitVerifyPdfWidth()">Fit width</button><button type="button" onclick="verifyNextSuggestion()" ${candidates.length<2?'disabled':''}>Next match</button></div></div>
    <div class="verify-pdf-shell" id="verifyPdfShell"><div id="verifyPdfPage" class="verify-pdf-stack"><div class="verify-loader"></div></div></div>
    <div class="verify-bottom-bar"><button class="verify-proof-float" type="button" onclick="toggleVerifyProof()">▣ Payment proof</button><div class="verify-workspace-actions"><button class="verify-action-secondary" onclick="skipVerifyOrder()">Skip</button><button class="verify-action-secondary" onclick="markVerifyNoMatch()">No match</button><button class="verify-action-primary" onclick="confirmVerifyPayment()" ${(!candidate||state.busy)?'disabled':''}>Confirm &amp; next</button></div></div>
    <div class="verify-proof-overlay hidden" id="verifyProofOverlay" onclick="if(event.target===this)toggleVerifyProof(false)"><div class="verify-proof-card"><button class="verify-proof-close" onclick="toggleVerifyProof(false)">×</button><h3>Customer payment proof</h3><img src="${verifyEscape(verifyPaymentImageUrl(order.paymentProof))}" alt="Customer payment proof"><p>Compare the receipt with the bank statement before confirming.</p></div></div>
    <p class="verify-workspace-footnote">Suggestions are not proof of payment. Confirm only after checking the statement transaction and receipt.</p>`;
  renderVerifyPdfPage(pageNo,candidate);
  const shell=document.getElementById('verifyPdfShell');
  if(shell) shell.addEventListener('scroll',handleVerifyPdfScroll,{passive:true});
  if(!window.__xredroVerifyResizeBound){window.addEventListener('resize',scheduleVerifyPdfResize,{passive:true});window.__xredroVerifyResizeBound=true;}
}
function verifyCustomerName(order) {
  const data=verifyParseFormData(order.formData); const f=data.find(x=>x.type!=='product'&&x.type!=='payment_account_name'&&x.type!=='payment_date'&&typeof x.value==='string'&&x.value.trim());
  return f?.value||'Customer';
}
function verifyPaymentImageUrl(id){return `https://nyc.cloud.appwrite.io/v1/storage/buckets/${VERIFY_BUCKET}/files/${encodeURIComponent(id)}/view?project=${VERIFY_PROJECT}`;}
async function renderVerifyPdfPage(pageNo,candidate) {
  const state=verifyWorkspace, shell=document.getElementById('verifyPdfShell'), stack=document.getElementById('verifyPdfPage');
  if(!stack||!shell||!state?.pdf)return;
  state.viewPage=Math.min(state.pdf.numPages,Math.max(1,pageNo||1));
  const token=++state.renderToken;
  try {
    stack.innerHTML='';
    const firstPage=state.pages[0];
    const baseViewport=firstPage.page.getViewport({scale:1});
    const availableWidth=Math.max(220,shell.clientWidth-24);
    state.baseFitScale=availableWidth/baseViewport.width;
    const scale=state.baseFitScale*state.zoom;
    const zoomLabel=document.getElementById('verifyZoomLabel');
    if(zoomLabel)zoomLabel.textContent=state.zoom===1?'Fit width':`${Math.round(state.zoom*100)}%`;
    for(let pageNo=1;pageNo<=state.pdf.numPages;pageNo++) {
      if(token!==state.renderToken)return;
      const pg=state.pages[pageNo-1];
      const viewport=pg.page.getViewport({scale});
      const pageHost=document.createElement('div');pageHost.className='verify-pdf-page';pageHost.dataset.page=String(pageNo);pageHost.style.width=`${viewport.width}px`;pageHost.style.height=`${viewport.height}px`;
      const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);canvas.className='verify-pdf-canvas';pageHost.appendChild(canvas);
      const highlights=document.createElement('div');highlights.className='verify-pdf-highlights';highlights.style.width=`${viewport.width}px`;highlights.style.height=`${viewport.height}px`;pageHost.appendChild(highlights);stack.appendChild(pageHost);
      canvas.addEventListener('click',ev=>{
        const rect=canvas.getBoundingClientRect();const px=(ev.clientX-rect.left)*(canvas.width/rect.width);const py=(ev.clientY-rect.top)*(canvas.height/rect.height);
        const point=viewport.convertToPdfPoint(px,py);const nearest=pg.lines.reduce((best,line)=>!best||Math.abs(line.y-point[1])<Math.abs(best.y-point[1])?line:best,null);
        if(!nearest)return;
        const activeOrder=state.orders[state.currentIndex];const amount=verifyMoney(activeOrder?.totalAmount);
        const manual={manual:true,pageNo,y:nearest.y,lineText:nearest.text,context:nearest.text,amount,score:0,fingerprint:['manual',pageNo,Math.round(nearest.y),verifyNormText(nearest.text)].join('|')};
        state.manualCandidate=manual;state.manualOrderId=activeOrder?.$id||null;state.viewPage=pageNo;
        const status=document.getElementById('verifyMatchStatus');if(status){status.classList.remove('no-match');status.textContent=`Manual line selected · Page ${pageNo}. Check the transaction and receipt before confirming.`;}
        const confirmBtn=document.querySelector('.verify-action-primary');if(confirmBtn)confirmBtn.disabled=!!state.busy;
        document.querySelectorAll('.verify-pdf-highlight').forEach(el=>el.classList.remove('verify-pdf-highlight-active'));
        const activeHighlight=pageHost.querySelector('.verify-pdf-highlights');if(activeHighlight)activeHighlight.classList.add('verify-pdf-highlight-active');
        const pageLabel=document.getElementById('verifyPageLabel');if(pageLabel)pageLabel.textContent=`Page ${pageNo} / ${state.pdf.numPages}`;
      });
      await pg.page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      if(token!==state.renderToken)return;
      const activeOrder=state.orders[state.currentIndex];
      const activeCandidate=state.manualOrderId===activeOrder?.$id&&state.manualCandidate?state.manualCandidate:candidate;
      if(activeCandidate&&activeCandidate.pageNo===pageNo) {
        pg.items.forEach(item=>{
          if(Math.abs(item.y-activeCandidate.y)>5.5)return;
          const r=viewport.convertToViewportRectangle([item.x,item.y,item.x+Math.max(item.width,3),item.y+Math.max(item.height,7)]);
          const left=Math.min(r[0],r[2]),top=Math.min(r[1],r[3]),width=Math.max(4,Math.abs(r[2]-r[0])),height=Math.max(8,Math.abs(r[3]-r[1]));
          const mark=document.createElement('span');mark.className='verify-pdf-highlight';Object.assign(mark.style,{left:`${left}px`,top:`${top}px`,width:`${width}px`,height:`${height}px`});highlights.appendChild(mark);
        });
      }
    }
    const target=stack.querySelector(`[data-page="${state.viewPage}"]`);
    if(target) {
      const candidateY=candidate&&candidate.pageNo===state.viewPage?candidate.y:null;
      if(candidateY!==null) {
        const pg=state.pages[state.viewPage-1];const viewport=pg.page.getViewport({scale});
        const scaledY=viewport.height-(candidateY*scale);
        shell.scrollTop=Math.max(0,target.offsetTop+scaledY-shell.clientHeight*.38);
      } else shell.scrollTop=Math.max(0,target.offsetTop-8);
    }
    updateVerifyVisiblePage();
  } catch(err) { console.error('Could not render statement PDF:',err);stack.innerHTML='<p class="verify-error">This statement page could not be rendered. Try Fit width or adjust zoom.</p>'; }
}
function updateVerifyVisiblePage(){
  const state=verifyWorkspace,shell=document.getElementById('verifyPdfShell'),stack=document.getElementById('verifyPdfPage');if(!state||!shell||!stack)return;
  const pages=[...stack.querySelectorAll('.verify-pdf-page')];if(!pages.length)return;
  const middle=shell.getBoundingClientRect().top+Math.min(shell.clientHeight*.35,140);let best=pages[0],distance=Infinity;
  pages.forEach(p=>{const r=p.getBoundingClientRect();const d=Math.abs(r.top-middle);if(d<distance){distance=d;best=p;}});
  const visible=Number(best.dataset.page)||1;state.viewPage=visible;
  const label=document.getElementById('verifyPageLabel');if(label)label.textContent=`Page ${visible} / ${state.pdf.numPages}`;
  const order=state.orders[state.currentIndex];const c=state.manualOrderId===order?.$id&&state.manualCandidate?state.manualCandidate:(state.candidatesByOrder.get(order?.$id)||[])[state.currentCandidateIndex]||null;
  const btn=document.querySelector('.verify-action-primary');if(btn)btn.disabled=!!state.busy||!c||c.pageNo!==visible;
}
function handleVerifyPdfScroll(){if(verifyWorkspace?.scrollFrame)return; if(verifyWorkspace)verifyWorkspace.scrollFrame=requestAnimationFrame(()=>{if(verifyWorkspace)verifyWorkspace.scrollFrame=null;updateVerifyVisiblePage();});}
function scheduleVerifyPdfResize(){if(!verifyWorkspace?.pdf)return;clearTimeout(verifyWorkspace.resizeTimer);verifyWorkspace.resizeTimer=setTimeout(()=>{const s=verifyWorkspace,order=s.orders[s.currentIndex],c=s.manualOrderId===order?.$id&&s.manualCandidate?s.manualCandidate:(s.candidatesByOrder.get(order?.$id)||[])[s.currentCandidateIndex]||null;renderVerifyPdfPage(s.viewPage||1,c);},180);}
function fitVerifyPdfWidth(){if(!verifyWorkspace)return;verifyWorkspace.zoom=1;const s=verifyWorkspace,order=s.orders[s.currentIndex],c=s.manualOrderId===order?.$id&&s.manualCandidate?s.manualCandidate:(s.candidatesByOrder.get(order?.$id)||[])[s.currentCandidateIndex]||null;renderVerifyPdfPage(s.viewPage||1,c);}
function toggleVerifyDetails(){const details=document.getElementById('verifyOrderDetails'),btn=document.getElementById('verifyDetailsToggle');if(!details||!btn)return;const opening=details.classList.contains('hidden');details.classList.toggle('hidden',!opening);btn.setAttribute('aria-expanded',String(opening));btn.textContent=opening?'Details ▴':'Details ▾';}
function verifyPrevPage(){const s=verifyWorkspace;const p=Math.max(1,(s.viewPage||1)-1);const order=s.orders[s.currentIndex];const c=s.manualOrderId===order?.$id&&s.manualCandidate?s.manualCandidate:(s.candidatesByOrder.get(order?.$id)||[])[s.currentCandidateIndex]||null;const target=document.querySelector(`.verify-pdf-page[data-page="${p}"]`);if(target){document.getElementById('verifyPdfShell').scrollTop=target.offsetTop-8;}else renderVerifyPdfPage(p,c);}
function verifyNextPage(){const s=verifyWorkspace;const p=Math.min(s.pdf.numPages,(s.viewPage||1)+1);const order=s.orders[s.currentIndex];const c=s.manualOrderId===order?.$id&&s.manualCandidate?s.manualCandidate:(s.candidatesByOrder.get(order?.$id)||[])[s.currentCandidateIndex]||null;const target=document.querySelector(`.verify-pdf-page[data-page="${p}"]`);if(target){document.getElementById('verifyPdfShell').scrollTop=target.offsetTop-8;}else renderVerifyPdfPage(p,c);}
function changeVerifyZoom(delta){const s=verifyWorkspace;s.zoom=Math.min(2.1,Math.max(.65,s.zoom+delta));const order=s.orders[s.currentIndex];const c=s.manualOrderId===order?.$id&&s.manualCandidate?s.manualCandidate:(s.candidatesByOrder.get(order?.$id)||[])[s.currentCandidateIndex]||null;renderVerifyPdfPage(s.viewPage||c?.pageNo||1,c);}
function verifyNextSuggestion(){const s=verifyWorkspace,c=s.candidatesByOrder.get(s.orders[s.currentIndex]?.$id)||[];if(s.currentCandidateIndex<c.length-1){s.currentCandidateIndex++;s.manualCandidate=null;s.manualOrderId=null;renderVerifyViewer();}}
function changeVerifyDateWindow(value){verifyWorkspace.dateWindow=Number(value);buildVerifySuggestions();verifyWorkspace.currentCandidateIndex=0;verifyWorkspace.manualCandidate=null;verifyWorkspace.manualOrderId=null;renderVerifyViewer();}
function toggleVerifyProof(force){const el=document.getElementById('verifyProofOverlay');if(!el)return;const show=typeof force==='boolean'?force:el.classList.contains('hidden');el.classList.toggle('hidden',!show);}
async function confirmVerifyPayment(){
  const s=verifyWorkspace,order=s.orders[s.currentIndex],candidate=(s.manualOrderId===order?.$id&&s.manualCandidate)?s.manualCandidate:(s.candidatesByOrder.get(order?.$id)||[])[s.currentCandidateIndex];
  if(!order||!candidate||s.busy)return;
  if(candidate.pageNo!==s.viewPage){alert('Please return to the selected transaction in the PDF, or click a transaction line on the current page to select it manually.');return;}
  if(!confirm('Confirm that this bank statement transaction belongs to this order and mark the order as paid?'))return;
  s.busy=true;const btn=document.querySelector('.verify-action-primary');if(btn){btn.disabled=true;btn.textContent='Saving…';}
  try{
    await databases.updateDocument(VERIFY_DB_ID,VERIFY_ORDERS,order.$id,{status:'paid'});
    s.reviewed.add(order.$id);s.usedTransactions.add(candidate.fingerprint);s.manualCandidate=null;s.manualOrderId=null;
    try{localStorage.setItem(`xredro-used-transactions-${s.sellerId||'seller'}`,JSON.stringify([...s.usedTransactions]));}catch{}
    if(Array.isArray(allOrders)){const found=allOrders.find(o=>o.$id===order.$id);if(found)found.status='paid';}
    s.busy=false;
    const next=nextVerifyOrderIndex(s.currentIndex);if(next<0){renderVerifyComplete();return;}
    s.currentIndex=next;s.currentCandidateIndex=0;renderVerifyViewer();
  }catch(err){console.error('Could not update order status:',err);s.busy=false;alert(`Payment was not marked as paid because the update failed. Please try again.\n\n${err.message||'Appwrite update failed.'}`);renderVerifyViewer();}
}
function skipVerifyOrder(){const s=verifyWorkspace,order=s.orders[s.currentIndex];if(!order)return;s.skipped.add(order.$id);s.manualCandidate=null;s.manualOrderId=null;const next=nextVerifyOrderIndex(s.currentIndex);if(next<0){renderVerifyComplete();return;}s.currentIndex=next;s.currentCandidateIndex=0;renderVerifyViewer();}
function markVerifyNoMatch(){skipVerifyOrder();}
function renderVerifyComplete(){const s=verifyWorkspace,body=document.getElementById('verifyBody');body.innerHTML=`<div class="verify-complete"><h2>Verification session complete</h2><div class="verify-count-grid"><div><strong>${s.reviewed.size}</strong><span>Confirmed paid</span></div><div><strong>${s.skipped.size}</strong><span>Skipped / review later</span></div><div><strong>${Math.max(0,s.orders.length-s.reviewed.size-s.skipped.size)}</strong><span>Not reviewed</span></div></div><p class="verify-sub">Only orders you confirmed were marked as paid. Skipped orders remain unpaid.</p><button class="verify-btn-primary" onclick="closeVerifyOverlay();fetchOrders()">Done</button></div>`;}
