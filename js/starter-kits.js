/* Starter stores: one-tap starting points for new sellers (see js/setup-checklist.js for the matching to-do list).
   Everything here is a sample for the seller to replace. Every sample product carries sample:true, which the builder
   clears when the seller edits that product and which the dashboard checklist uses to know samples are left. */
(function (root) {
  "use strict";
  const STARTERS = [
 {
  "key": "beauty",
  "label": "Beauty & hair",
  "theme": "r4",
  "tagline": "Beauty and hair products",
  "cta": "Shop now",
  "products": [
   {
    "name": "Vitamin C serum",
    "price": "12500",
    "category": "Skincare",
    "description": "30ml bottle. Add your own description.",
    "img": "assets/starter/beauty-1.jpg"
   },
   {
    "name": "Matte lipstick",
    "price": "5500",
    "category": "Makeup",
    "description": "",
    "img": "assets/starter/beauty-2.jpg"
   },
   {
    "name": "Eau de parfum 100ml",
    "price": "38000",
    "category": "Fragrance",
    "description": "",
    "img": "assets/starter/beauty-3.jpg"
   },
   {
    "name": "Shea butter soap",
    "price": "3500",
    "category": "Skincare",
    "description": "",
    "img": "assets/starter/beauty-4.jpg"
   },
   {
    "name": "Body butter",
    "price": "9500",
    "category": "Skincare",
    "description": "",
    "img": "assets/starter/beauty-5.jpg"
   }
  ]
 },
 {
  "key": "fashion",
  "label": "Fashion & accessories",
  "theme": "r5",
  "tagline": "Fashion and accessories",
  "cta": "Shop now",
  "products": [
   {
    "name": "Leather handbag",
    "price": "45000",
    "category": "Bags",
    "description": "Add your own description.",
    "img": "assets/starter/fashion-1.jpg"
   },
   {
    "name": "Gold-tone watch",
    "price": "30000",
    "category": "Watches",
    "description": "",
    "img": "assets/starter/fashion-2.jpg"
   },
   {
    "name": "Pendant necklace",
    "price": "18000",
    "category": "Jewellery",
    "description": "",
    "img": "assets/starter/fashion-3.jpg"
   },
   {
    "name": "Midi dress",
    "price": "28000",
    "category": "Clothing",
    "description": "",
    "img": "assets/starter/fashion-4.jpg"
   },
   {
    "name": "Canvas sneakers",
    "price": "22000",
    "category": "Shoes",
    "description": "",
    "img": "assets/starter/fashion-5.jpg"
   }
  ]
 },
 {
  "key": "food",
  "label": "Food & baking",
  "theme": "r3",
  "tagline": "Fresh food and bakes",
  "cta": "Order now",
  "products": [
   {
    "name": "Birthday cake",
    "price": "28000",
    "category": "Cakes",
    "description": "Add your own description.",
    "img": "assets/starter/food-1.jpg"
   },
   {
    "name": "Cupcake box of 6",
    "price": "8500",
    "category": "Cupcakes",
    "description": "",
    "img": "assets/starter/food-2.jpg"
   },
   {
    "name": "Gift hamper",
    "price": "35000",
    "category": "Gifts",
    "description": "",
    "img": "assets/starter/food-3.jpg"
   },
   {
    "name": "Chocolate cake",
    "price": "26000",
    "category": "Cakes",
    "description": "",
    "img": "assets/starter/food-4.jpg"
   },
   {
    "name": "Honey 500g",
    "price": "9000",
    "category": "Pantry",
    "description": "",
    "img": "assets/starter/food-5.jpg"
   }
  ]
 },
 {
  "key": "gadgets",
  "label": "Gadgets & electronics",
  "theme": "r1",
  "tagline": "Gadgets and accessories",
  "cta": "Shop now",
  "products": [
   {
    "name": "Wireless earbuds",
    "price": "18500",
    "category": "Audio",
    "description": "Add your own description.",
    "img": "assets/starter/gadgets-1.jpg"
   },
   {
    "name": "Bluetooth speaker",
    "price": "24000",
    "category": "Audio",
    "description": "",
    "img": "assets/starter/gadgets-2.jpg"
   },
   {
    "name": "Power bank 20,000mAh",
    "price": "12500",
    "category": "Phones",
    "description": "",
    "img": "assets/starter/gadgets-3.jpg"
   },
   {
    "name": "Over-ear headphones",
    "price": "28500",
    "category": "Audio",
    "description": "",
    "img": "assets/starter/gadgets-4.jpg"
   },
   {
    "name": "Game controller",
    "price": "32000",
    "category": "Gaming",
    "description": "",
    "img": "assets/starter/gadgets-5.jpg"
   }
  ]
 },
 {
  "key": "home",
  "label": "Home & living",
  "theme": "r2",
  "tagline": "Things for the home",
  "cta": "Shop now",
  "products": [
   {
    "name": "Ceramic vase",
    "price": "14000",
    "category": "Decor",
    "description": "Add your own description.",
    "img": "assets/starter/home-1.jpg"
   },
   {
    "name": "Soy wax candle",
    "price": "6500",
    "category": "Decor",
    "description": "",
    "img": "assets/starter/home-2.jpg"
   },
   {
    "name": "Stoneware mug",
    "price": "4500",
    "category": "Kitchen",
    "description": "",
    "img": "assets/starter/home-3.jpg"
   },
   {
    "name": "Linen cushion",
    "price": "9000",
    "category": "Soft goods",
    "description": "",
    "img": "assets/starter/home-4.jpg"
   },
   {
    "name": "Potted plant",
    "price": "11000",
    "category": "Decor",
    "description": "",
    "img": "assets/starter/home-5.jpg"
   }
  ]
 }
];
  const TITLE_PLACEHOLDER = "Your store name";
  const BANK_SUBTITLE = "Pay by bank transfer to [bank name] [account number] ([account name]), then upload your payment proof.";
  function find(key) { return STARTERS.find(s => s.key === key) || null; }
  // Builds the form content for a starter. uid() makes field ids; resolve() turns a relative image path into a full address.
  function build(key, uid, resolve) {
    const s = find(key); if (!s) return null;
    const text = (label, type) => ({ id: uid(), type: type || "text", label, options: [], products: [] });
    return {
      title: TITLE_PLACEHOLDER, subtitle: BANK_SUBTITLE, theme: s.theme,
      storeConfig: { tagline: s.tagline, heroCta: s.cta },
      fields: [
        text("Full name"), text("Phone number"), text("Delivery address", "textarea"),
        { id: uid(), type: "product", label: "Products", options: [], products: s.products.map(p => ({
          name: p.name, price: p.price, imageId: "", imageUrl: resolve(p.img), category: p.category, description: p.description, sample: true })) }
      ]
    };
  }
  const api = { STARTERS, TITLE_PLACEHOLDER, BANK_SUBTITLE, find, build };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.XrStarter = api;
})(typeof window !== "undefined" ? window : globalThis);
