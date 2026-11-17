// Run from project root: node tools/test-storefront-dom.js  (stub DOM; tests cart drawer refresh and quantity capping)
const fs=require('fs'),vm=require('vm');
const els={};
const mk=(id)=>els[id]=els[id]||{id,innerHTML:'',textContent:'',style:{},attrs:{},classes:new Set(),
  classList:{toggle(c,f){const s=els[id].classes; (f===undefined?!s.has(c):f)?s.add(c):s.delete(c)},add(c){els[id].classes.add(c)},remove(c){els[id].classes.delete(c)},contains(c){return els[id].classes.has(c)}},
  setAttribute(k,v){els[id].attrs[k]=v}};
['sfCartLines','sfCartSubtotal','sfHeaderCount','sfCheckoutSummary','sfCheckoutBtn'].forEach(mk);
const badge={textContent:'0',classes:new Set(),classList:{toggle(c,f){f?badge.classes.add(c):badge.classes.delete(c)}}};
const listeners=[];
const ctx={console,document:{getElementById:id=>els[id]||null,querySelectorAll:()=>[badge],addEventListener:(t,f)=>listeners.push([t,f])},window:{},Number,Set,Array,Object,String,JSON,Math,RegExp};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('js/storefront-render.js','utf8')+fs.readFileSync('js/storefront-chrome.js','utf8')+";globalThis.f=storefrontRefreshCart",ctx);
const fields=[{id:'p1',type:'product',products:[{name:'Bag',price:'12000'},{name:'Watch <b>',price:'5000',imageUrl:'https://a.com/w.jpg'}]}];
ctx.f(fields,{p1_0:1,p1_1:2},'changeQty');
let failed=0;
const a=(c,m)=>{if(!c)failed++;console.log(c?'ok  ':'FAIL',m)};
a(els.sfCartSubtotal.textContent==='₦22,000','subtotal ₦22,000 -> '+els.sfCartSubtotal.textContent);
a(els.sfHeaderCount.textContent===3&&!els.sfHeaderCount.classes.has('is-zero'),'header count 3 visible');
a((els.sfCartLines.innerHTML.match(/class="sf-line"/g)||[]).length===2,'2 cart lines');
a(!els.sfCartLines.innerHTML.includes('<b>')&&els.sfCartLines.innerHTML.includes('&lt;b&gt;'),'product name escaped in cart');
a(els.sfCartLines.innerHTML.includes("changeQty('p1', 1, -2)"),'remove passes -qty');
a(els.sfCheckoutBtn.classes.has('is-disabled')===false&&els.sfCheckoutBtn.attrs['aria-disabled']==='false','checkout enabled');
a(els.sfCheckoutSummary.style.display==='block'&&els.sfCheckoutSummary.innerHTML.includes('2 &times;'),'checkout summary lists lines');
ctx.f(fields,{},'changeQty');
a(els.sfCartLines.innerHTML.includes('Your cart is empty')&&els.sfCheckoutBtn.classes.has('is-disabled')&&els.sfHeaderCount.classes.has('is-zero')&&els.sfCheckoutSummary.style.display==='none','empty cart state');
// changeQty: a sold-out product cannot be added; others work; nothing goes below zero
const src=fs.readFileSync('js/form.js','utf8'); const m=src.match(/function changeQty[\s\S]*?\n}\n/)[0];
const c2={cart:{},fields:[{id:'p1',type:'product',products:[{name:'Out',soldOut:true},{name:'In'},{name:'Old'}]}],document:{getElementById:()=>null},toasts:[],showToast(m){c2.toasts.push(m)},updateTotal(){}};
vm.createContext(c2); vm.runInContext(m+';globalThis.cq=changeQty',c2);
c2.cq('p1',0,1); a(!c2.cart.p1_0&&c2.toasts.length===1&&/sold out/i.test(c2.toasts[0]),'sold-out product cannot be added, customer is told');
c2.cq('p1',1,3); a(c2.cart.p1_1===3,'available product can be added');
c2.cq('p1',2,2); a(c2.cart.p1_2===2,'product without any stock flag is unaffected (old stores)');
c2.cq('p1',1,-100); a(c2.cart.p1_1===0,'never below zero');
c2.cq('p1',0,-1); a(!c2.cart.p1_0,'removing a sold-out line is still allowed');

// layer guard: opening one layer closes the others
const guard=listeners.find(l=>l[0]==='change'); a(!!guard,'layer guard listener registered');
const boxes=['navToggle','searchToggle','cartToggle','checkoutToggle'].map(id=>({id,checked:false,matches:()=>true,closest:()=>root}));
const root={querySelectorAll:()=>boxes.filter(b=>b.checked)};
boxes[0].checked=true; boxes[2].checked=true; // menu and cart both on
guard[1]({target:boxes[2]}); a(boxes[2].checked&&!boxes[0].checked,'opening the cart closes the menu');
boxes[3].checked=true; guard[1]({target:boxes[3]}); a(boxes[3].checked&&!boxes[2].checked,'opening checkout closes the cart');
boxes[3].checked=false; guard[1]({target:boxes[3]}); a(boxes.every(b=>!b.checked),'closing a layer opens nothing');
guard[1]({target:{matches:()=>false,checked:true}}); a(true,'unrelated checkboxes are ignored');
console.log(failed?`\n${failed} FAILED`:'\nALL DOM CHECKS PASSED'); process.exit(failed?1:0);
