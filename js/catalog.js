const CATALOG_DB_ID = "695c4fce0039f513dc83";
const CATALOG_FORMS = "form";
const CATALOG_USERS = "695c501b001d24549b03";
const CATALOG_BUCKET = "696825350032fe17c1eb";
const catalogClient = new Appwrite.Client().setEndpoint("https://nyc.cloud.appwrite.io/v1").setProject("695981480033c7a4eb0d");
const catalogAccount = new Appwrite.Account(catalogClient);
const catalogDb = new Appwrite.Databases(catalogClient);
const catalogStorage = new Appwrite.Storage(catalogClient);
let catalogProducts = [];
let generatedCatalogs = [];
let catalogImageFailures = 0;

const byId = id => document.getElementById(id);
function formatNairaCatalog(value) {
  const amount = Number(String(value ?? "").replace(/[₦,\s]/g, ""));
  return Number.isFinite(amount) ? `₦${amount.toLocaleString("en-NG")}` : String(value || "");
}
function safeText(value) { return String(value ?? "").trim(); }
function appwriteProductImageUrl(fileId) {
  return `https://nyc.cloud.appwrite.io/v1/storage/buckets/${CATALOG_BUCKET}/files/${encodeURIComponent(fileId)}/view?project=695981480033c7a4eb0d`;
}
function showCatalogMessage(message, isError=false) {
  const state = byId("productState");
  state.textContent = message;
  state.classList.toggle("error", isError);
  state.classList.remove("hidden");
}
function updateSelectionCount() {
  const count = document.querySelectorAll(".catalog-product-check:checked").length;
  byId("selectedCount").textContent = `${count} selected`;
  byId("selectAllBtn").textContent = count === catalogProducts.length ? "Clear selection" : "Select all";
}
function renderProductChoices() {
  const grid = byId("productGrid");
  grid.innerHTML = "";
  if (!catalogProducts.length) {
    showCatalogMessage("No products found yet. Add products in Form Builder and save your form first.");
    byId("generateBtn").disabled = true;
    return;
  }
  byId("productState").classList.add("hidden");
  byId("generateBtn").disabled = false;
  catalogProducts.forEach((product, index) => {
    const label = document.createElement("label");
    label.className = "catalog-select-card selected";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox"; checkbox.className = "catalog-product-check"; checkbox.checked = true; checkbox.dataset.index = String(index);
    checkbox.addEventListener("change", () => { label.classList.toggle("selected", checkbox.checked); updateSelectionCount(); });
    let imageNode;
    if (product.imageUrl) {
      imageNode = document.createElement("img"); imageNode.crossOrigin = "anonymous"; imageNode.src = product.imageUrl; imageNode.alt = product.name || "Product photo"; imageNode.loading = "lazy";
      imageNode.onerror = () => { const placeholder = document.createElement("span"); placeholder.className = "catalog-thumb-placeholder"; placeholder.textContent = "□"; imageNode.replaceWith(placeholder); };
    } else {
      imageNode = document.createElement("span"); imageNode.className = "catalog-thumb-placeholder"; imageNode.textContent = "□";
    }
    const meta = document.createElement("span"); meta.className = "catalog-product-meta";
    const name = document.createElement("span"); name.className = "catalog-product-name"; name.textContent = product.name || "Unnamed product";
    const price = document.createElement("span"); price.className = "catalog-product-price"; price.textContent = formatNairaCatalog(product.price);
    meta.append(name, price); label.append(checkbox, imageNode, meta); grid.appendChild(label);
  });
  updateSelectionCount();
}
async function loadCatalogProducts() {
  try {
    const user = await catalogAccount.get();
    let profileName = user.name || user.email.split("@")[0];
    try { const profile = await catalogDb.getDocument(CATALOG_DB_ID, CATALOG_USERS, user.$id); profileName = profile.username || profileName; } catch (_) {}
    byId("shopName").value = profileName;
    const form = await catalogDb.getDocument(CATALOG_DB_ID, CATALOG_FORMS, user.$id);
    const fields = Array.isArray(form.fields) ? form.fields.map(item => { try { return typeof item === "string" ? JSON.parse(item) : item; } catch (_) { return null; } }).filter(Boolean) : [];
    catalogProducts = fields.filter(f => f.type === "product" && Array.isArray(f.products)).flatMap(f => f.products).map(p => ({
      name: safeText(p.name), price: p.price, description: safeText(p.description),
      imageId: p.imageId || p.imageID || p.fileId || "", imageUrl: safeText(p.imageUrl || p.imageURL || "")
    })).filter(p => p.name || p.price || p.imageUrl || p.imageId);
    catalogProducts.forEach(product => {
      // The customer form uses the saved imageUrl directly. Preserve that same
      // URL when valid; replace only temporary blob/data URLs with the durable
      // Appwrite file-view URL built from the saved file ID.
      const temporaryUrl = /^(blob:|data:)/i.test(product.imageUrl);
      if ((!product.imageUrl || temporaryUrl) && product.imageId) {
        product.imageUrl = appwriteProductImageUrl(product.imageId);
      }
      if (product.imageUrl && !/^https?:\/\//i.test(product.imageUrl) && product.imageId) {
        product.imageUrl = appwriteProductImageUrl(product.imageId);
      }
    });
    renderProductChoices();
  } catch (err) {
    console.error("Catalogue load failed:", err);
    if (err?.code === 401) { window.location.replace("login.html"); return; }
    showCatalogMessage("We couldn't load your saved products. Open Form Builder, save your products, then try again.", true);
    byId("generateBtn").disabled = true;
  }
}
function selectedProducts() {
  return Array.from(document.querySelectorAll(".catalog-product-check:checked"))
    .map(el => catalogProducts[Number(el.dataset.index)]).filter(Boolean);
}
function roundedRect(ctx, x, y, w, h, r, fill) {
  ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
}
function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight, maxLines=2) {
  const words = String(text || "").split(/\s+/); let line = "", lines = [];
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; } else line = test;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines = lines.slice(0,maxLines); let last = lines[maxLines-1]; while (ctx.measureText(last + "…").width > maxWidth && last.length > 1) last = last.slice(0,-1); lines[maxLines-1] = last + "…"; }
  lines.forEach((ln,i) => ctx.fillText(ln,x,y+i*lineHeight));
  return lines.length;
}
function loadImage(url) {
  return new Promise(resolve => {
    if (!url) return resolve(null);
    const img = new Image();
    // Keep anonymous CORS enabled: catalogue images are exported from canvas,
    // and drawing a cross-origin image without CORS would taint the canvas.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => {
      catalogImageFailures++;
      console.warn("Catalogue could not load a product image. Verify that the Appwrite file has read permission for Any, and that xredro.github.io is registered as a Web platform:", url);
      resolve(null);
    };
    img.src = url;
  });
}
function drawImageCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height); const sw = w / scale, sh = h / scale;
  const sx = (img.width - sw) / 2, sy = (img.height - sh) / 2;
  ctx.save(); roundedRect(ctx,x,y,w,h,12,null); ctx.clip(); ctx.drawImage(img,sx,sy,sw,sh,x,y,w,h); ctx.restore();
}
async function canvasToBlob(canvas) {
  return new Promise((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not export this image.")), "image/png"));
}
async function renderCatalogPage(products, pageNumber, totalPages, format, shop, title) {
  const canvas = document.createElement("canvas");
  const sizes = { status:[1080,1920], feed:[1080,1350], square:[1080,1080] };
  [canvas.width,canvas.height] = sizes[format] || sizes.status;
  const ctx = canvas.getContext("2d");
  const W=canvas.width,H=canvas.height;
  ctx.fillStyle="#f5f6f2"; ctx.fillRect(0,0,W,H);
  const pad=48; const headerH = format === "status" ? 220 : (format === "feed" ? 175 : 150);
  ctx.fillStyle="#172015"; ctx.font="800 28px Arial, sans-serif"; ctx.fillText(shop.slice(0,48) || "My Shop",pad,54);
  ctx.font="800 44px Arial, sans-serif"; wrapCanvasText(ctx,title || "Available Products",pad,112,W-pad*2,52,2);
  ctx.fillStyle="#65705f"; ctx.font="500 22px Arial, sans-serif"; ctx.fillText(`Page ${pageNumber} of ${totalPages}`,pad,H-24);
  const perPage=products.length; const cols=perPage===9?3:2; const rows=Math.ceil(perPage/cols);
  const gap=20; const gridTop=headerH; const gridBottom=H-62; const cardW=(W-pad*2-gap*(cols-1))/cols; const cardH=(gridBottom-gridTop-gap*(rows-1))/rows;
  const photoH=Math.max(100,Math.floor(cardH*.67));
  for(let i=0;i<products.length;i++){
    const product=products[i]; const col=i%cols,row=Math.floor(i/cols); const x=pad+col*(cardW+gap),y=gridTop+row*(cardH+gap);
    roundedRect(ctx,x,y,cardW,cardH,18,"#ffffff");
    const photoX=x+12,photoY=y+12,photoW=cardW-24,actualPhotoH=Math.min(photoH,cardH-105);
    const img=await loadImage(product.imageUrl);
    if(img){ drawImageCover(ctx,img,photoX,photoY,photoW,actualPhotoH); }
    else { roundedRect(ctx,photoX,photoY,photoW,actualPhotoH,12,"#eef0e9"); ctx.fillStyle="#899181"; ctx.font=`700 ${cols===3?28:36}px Arial`; ctx.textAlign="center"; ctx.fillText("No photo",photoX+photoW/2,photoY+actualPhotoH/2+10); ctx.textAlign="left"; }
    const textY=photoY+actualPhotoH+34;
    ctx.fillStyle="#20251e"; ctx.font=`700 ${cols===3?22:25}px Arial, sans-serif`;
    const usedLines=wrapCanvasText(ctx,product.name||"Product",x+14,textY,cardW-28,cols===3?27:30,2);
    ctx.fillStyle="#486b36"; ctx.font=`800 ${cols===3?23:27}px Arial, sans-serif`;
    ctx.fillText(formatNairaCatalog(product.price),x+14,textY+usedLines*(cols===3?27:30)+8,cardW-28);
  }
  return { canvas, blob: await canvasToBlob(canvas) };
}
async function generateCatalog() {
  const products=selectedProducts();
  if(!products.length){ showToast("Select at least one product first.","warning"); return; }
  const btn=byId("generateBtn"); btn.disabled=true; btn.textContent="Generating…";
  byId("resultsSection").classList.add("hidden");
  try {
    const perImage=Number(byId("perImage").value); const format=byId("catalogFormat").value;
    const totalPages=Math.ceil(products.length/perImage); const shop=safeText(byId("shopName").value)||"My Shop"; const title=safeText(byId("catalogTitle").value)||"Available Products";
    generatedCatalogs=[];
    catalogImageFailures = 0;
    for(let page=0;page<totalPages;page++){
      const batch=products.slice(page*perImage,(page+1)*perImage);
      const rendered=await renderCatalogPage(batch,page+1,totalPages,format,shop,title);
      generatedCatalogs.push({blob:rendered.blob,canvas:rendered.canvas,filename:`xredro-catalog-${String(page+1).padStart(2,"0")}.png`});
    }
    renderGeneratedResults(format);
    byId("resultsDescription").textContent=`${products.length} products · ${generatedCatalogs.length} image${generatedCatalogs.length===1?"":"s"}`;
    byId("resultsSection").classList.remove("hidden");
    if (catalogImageFailures > 0) {
      showToast(`${catalogImageFailures} product photo(s) could not be embedded. Check Appwrite file read permissions and add xredro.github.io under Appwrite Settings → Platforms.`, "warning");
    }
    byId("resultsSection").scrollIntoView({behavior:"smooth",block:"start"});
  } catch(err) { console.error(err); showToast(err.message||"Catalogue generation failed. Try fewer products or another format.","error"); }
  finally { btn.disabled=false; btn.textContent="Generate catalogue images"; }
}
function renderGeneratedResults(format) {
  const root=byId("catalogResults"); root.innerHTML="";
  generatedCatalogs.forEach((item,index)=>{
    const card=document.createElement("article"); card.className=`catalog-result-card format-${format}`;
    const image=document.createElement("img"); image.alt=`Catalogue image ${index+1}`; image.src=URL.createObjectURL(item.blob);
    const foot=document.createElement("div"); foot.className="catalog-result-foot";
    const label=document.createElement("strong"); label.textContent=`Image ${index+1} of ${generatedCatalogs.length}`;
    const download=document.createElement("button"); download.className="download-one"; download.type="button"; download.textContent="Download PNG"; download.addEventListener("click",()=>downloadBlob(item.blob,item.filename));
    foot.append(label,download); card.append(image,foot); root.appendChild(card);
  });
}
function downloadBlob(blob, filename) {
  const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500);
}
async function downloadAllCatalogs() {
  if(!generatedCatalogs.length) return;
  if(typeof JSZip === "undefined") { showToast("ZIP support could not load. Download images one at a time.","warning"); return; }
  const btn=byId("downloadAllBtn"); btn.disabled=true; btn.textContent="Preparing ZIP…";
  try { const zip=new JSZip(); generatedCatalogs.forEach(item=>zip.file(item.filename,item.blob)); const blob=await zip.generateAsync({type:"blob"}); downloadBlob(blob,"xredro-catalogue-images.zip"); }
  catch(err){ console.error(err); showToast("Could not package the images. Download them individually.","error"); }
  finally { btn.disabled=false; btn.textContent="Download all (.zip)"; }
}
byId("selectAllBtn").addEventListener("click",()=>{
  const checks=Array.from(document.querySelectorAll(".catalog-product-check"));
  const allSelected=checks.length && checks.every(el=>el.checked);
  checks.forEach(el=>{el.checked=!allSelected;el.closest(".catalog-select-card").classList.toggle("selected",!allSelected);}); updateSelectionCount();
});
byId("generateBtn").addEventListener("click",generateCatalog);
byId("downloadAllBtn").addEventListener("click",downloadAllCatalogs);
const burger=document.querySelector(".burger"),mobileMenu=document.querySelector(".mobile-menu");
if(burger&&mobileMenu) burger.addEventListener("click",()=>{const open=mobileMenu.classList.toggle("open");burger.setAttribute("aria-expanded",String(open));});
loadCatalogProducts();
