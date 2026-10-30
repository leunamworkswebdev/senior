/* Senior Master Carwash - services and prices. ONE source of truth: used by the website and by the server.
   price: number = confirmed (PHP). Missing or null = "Price to be confirmed". */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CATALOG = factory();
})(this, function () {
  const SIZE_LABELS = { small: 'Small', medium: 'Medium', large: 'Large', xl: 'Extra Large', xxl: 'Extra XL' };
  const VEHICLE_SIZES = {
    motorcycle: ['small', 'medium'],
    taxi: ['small', 'medium'],
    car: ['small', 'medium', 'large', 'xl', 'xxl']
  };
  const SERVICES = {
    'moto-wash': { label: 'Wash + Tire Black', category: 'wash', vehicles: ['motorcycle'], prices: { small: 120, medium: 150 } },
    'moto-wax': { label: 'Wash & Wax (with Tire Black)', category: 'wash', vehicles: ['motorcycle'], prices: { small: 150, medium: 180 } },
    'taxi-wash': { label: 'Wash + Tire Black', category: 'wash', vehicles: ['taxi'], prices: { small: null, medium: 120 } },
    'car-b2z': { label: 'Car Wash - Back 2 Zero', category: 'wash', vehicles: ['car'], prices: { small: 350, medium: 450, large: 450, xl: 550 } }, // Medium-Large rate = 450
    'car-express': { label: 'Express Wash', category: 'wash', vehicles: ['car'], prices: { small: 150, medium: 200, large: 220, xl: 270, xxl: 320 } },
    'car-ultimate': { label: 'Ultimate Wash', category: 'wash', vehicles: ['car'], prices: { small: 270, medium: 380, large: 420, xl: 450, xxl: 470 } },
    'car-diamond': { label: 'Diamond Wash', category: 'wash', vehicles: ['car'], prices: { small: 700, medium: 800, large: 900, xl: 1000, xxl: 1100 } },
    'interior': { label: 'Interior Detailing', category: 'detailing', vehicles: ['car'], prices: { small: 3000, medium: 3500, large: 4000, xl: 4500 } },
    'exterior': { label: 'Exterior Detailing', category: 'detailing', vehicles: ['car'], prices: { small: 3500, medium: 4500, large: 5500, xl: 6500 } },
    'other-buff': { label: 'Machine Buff', category: 'other', vehicles: ['motorcycle', 'taxi', 'car'], prices: {} },
    'other-vacuum': { label: 'Vacuum', category: 'other', vehicles: ['motorcycle', 'taxi', 'car'], prices: {} },
    'other-engine': { label: 'Engine Wash', category: 'other', vehicles: ['motorcycle', 'taxi', 'car'], prices: {} },
    'other-headlight': { label: 'Headlight Restoration', category: 'other', vehicles: ['motorcycle', 'taxi', 'car'], prices: {} },
    'other-rain': { label: 'Rain Water Marks Removal', category: 'other', vehicles: ['motorcycle', 'taxi', 'car'], prices: {} }
  };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  /* number = confirmed price, null = to be confirmed, undefined = nothing selected */
  function getPrice(serviceId, size) {
    if (!serviceId || !size || !has(SERVICES, serviceId)) return undefined;
    const p = SERVICES[serviceId].prices[size];
    return typeof p === 'number' ? p : null;
  }
  return { SIZE_LABELS, VEHICLE_SIZES, SERVICES, getPrice, has };
});
