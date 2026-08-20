// Major world cities, each mapped to the IANA zone that actually governs it.
//
// The city is a label; the zone is the value. Nothing downstream ever sees the
// city — the schedule row stores "America/Chicago" exactly as it always has, so
// DST, the scheduler and the call path are untouched by this file existing.
//
// Offsets are NOT stored here on purpose. "Dallas (UTC -5)" is only true for
// half the year; the other half it is -6. Every label is built at render time
// from the zone itself (see offsetLabel), so the list cannot drift out of date
// and nobody has to remember to edit it twice a year.
//
// Order is roughly west to east rather than alphabetical, for two reasons: an
// empty datalist is drawn in document order, where a geographic sweep reads
// better than an A-to-Z jumble; and zoneCity() takes the FIRST entry matching a
// zone, so whichever city is listed first becomes the one shown when that zone
// is loaded back for editing. Dallas therefore leads America/Chicago — several
// cities share that zone and this is the one in use here.
//
// Several cities per zone is the point, not a mistake: someone thinking
// "Houston" should not have to know their zone is named after Chicago.
export const TZ_CITIES = [
  { city: 'Honolulu',        zone: 'Pacific/Honolulu' },
  { city: 'Anchorage',       zone: 'America/Anchorage' },
  { city: 'Los Angeles',     zone: 'America/Los_Angeles' },
  { city: 'San Francisco',   zone: 'America/Los_Angeles' },
  { city: 'Seattle',         zone: 'America/Los_Angeles' },
  { city: 'San Diego',       zone: 'America/Los_Angeles' },
  { city: 'Las Vegas',       zone: 'America/Los_Angeles' },
  { city: 'Vancouver',       zone: 'America/Vancouver' },
  { city: 'Phoenix',         zone: 'America/Phoenix' },
  { city: 'Denver',          zone: 'America/Denver' },
  { city: 'Salt Lake City',  zone: 'America/Denver' },
  { city: 'Calgary',         zone: 'America/Edmonton' },
  { city: 'Dallas',          zone: 'America/Chicago' },
  { city: 'Houston',         zone: 'America/Chicago' },
  { city: 'Austin',          zone: 'America/Chicago' },
  { city: 'San Antonio',     zone: 'America/Chicago' },
  { city: 'Chicago',         zone: 'America/Chicago' },
  { city: 'Minneapolis',     zone: 'America/Chicago' },
  { city: 'New Orleans',     zone: 'America/Chicago' },
  { city: 'Winnipeg',        zone: 'America/Winnipeg' },
  { city: 'Mexico City',     zone: 'America/Mexico_City' },
  { city: 'New York',        zone: 'America/New_York' },
  { city: 'Boston',          zone: 'America/New_York' },
  { city: 'Philadelphia',    zone: 'America/New_York' },
  { city: 'Washington',      zone: 'America/New_York' },
  { city: 'Atlanta',         zone: 'America/New_York' },
  { city: 'Miami',           zone: 'America/New_York' },
  { city: 'Detroit',         zone: 'America/Detroit' },
  { city: 'Toronto',         zone: 'America/Toronto' },
  { city: 'Montreal',        zone: 'America/Toronto' },
  { city: 'Havana',          zone: 'America/Havana' },
  { city: 'Panama City',     zone: 'America/Panama' },
  { city: 'Bogota',          zone: 'America/Bogota' },
  { city: 'Lima',            zone: 'America/Lima' },
  { city: 'Caracas',         zone: 'America/Caracas' },
  { city: 'Santiago',        zone: 'America/Santiago' },
  { city: 'Halifax',         zone: 'America/Halifax' },
  { city: 'Buenos Aires',    zone: 'America/Argentina/Buenos_Aires' },
  { city: 'Montevideo',      zone: 'America/Montevideo' },
  { city: 'Sao Paulo',       zone: 'America/Sao_Paulo' },
  { city: 'Rio de Janeiro',  zone: 'America/Sao_Paulo' },
  { city: 'St Johns',        zone: 'America/St_Johns' },
  { city: 'Reykjavik',       zone: 'Atlantic/Reykjavik' },
  { city: 'UTC',             zone: 'UTC', label: 'UTC' },
  { city: 'London',          zone: 'Europe/London' },
  { city: 'Dublin',          zone: 'Europe/Dublin' },
  { city: 'Lisbon',          zone: 'Europe/Lisbon' },
  { city: 'Accra',           zone: 'Africa/Accra' },
  { city: 'Casablanca',      zone: 'Africa/Casablanca' },
  { city: 'Paris',           zone: 'Europe/Paris' },
  { city: 'Madrid',          zone: 'Europe/Madrid' },
  { city: 'Barcelona',       zone: 'Europe/Madrid' },
  { city: 'Amsterdam',       zone: 'Europe/Amsterdam' },
  { city: 'Brussels',        zone: 'Europe/Brussels' },
  { city: 'Berlin',          zone: 'Europe/Berlin' },
  { city: 'Munich',          zone: 'Europe/Berlin' },
  { city: 'Frankfurt',       zone: 'Europe/Berlin' },
  { city: 'Zurich',          zone: 'Europe/Zurich' },
  { city: 'Geneva',          zone: 'Europe/Zurich' },
  { city: 'Milan',           zone: 'Europe/Rome' },
  { city: 'Rome',            zone: 'Europe/Rome' },
  { city: 'Vienna',          zone: 'Europe/Vienna' },
  { city: 'Prague',          zone: 'Europe/Prague' },
  { city: 'Warsaw',          zone: 'Europe/Warsaw' },
  { city: 'Stockholm',       zone: 'Europe/Stockholm' },
  { city: 'Oslo',            zone: 'Europe/Oslo' },
  { city: 'Copenhagen',      zone: 'Europe/Copenhagen' },
  { city: 'Budapest',        zone: 'Europe/Budapest' },
  { city: 'Lagos',           zone: 'Africa/Lagos' },
  { city: 'Helsinki',        zone: 'Europe/Helsinki' },
  { city: 'Athens',          zone: 'Europe/Athens' },
  { city: 'Bucharest',       zone: 'Europe/Bucharest' },
  { city: 'Kyiv',            zone: 'Europe/Kyiv' },
  { city: 'Istanbul',        zone: 'Europe/Istanbul' },
  { city: 'Cairo',           zone: 'Africa/Cairo' },
  { city: 'Jerusalem',       zone: 'Asia/Jerusalem' },
  { city: 'Tel Aviv',        zone: 'Asia/Jerusalem' },
  { city: 'Johannesburg',    zone: 'Africa/Johannesburg' },
  { city: 'Nairobi',         zone: 'Africa/Nairobi' },
  { city: 'Moscow',          zone: 'Europe/Moscow' },
  { city: 'Riyadh',          zone: 'Asia/Riyadh' },
  { city: 'Dubai',           zone: 'Asia/Dubai' },
  { city: 'Tehran',          zone: 'Asia/Tehran' },
  { city: 'Karachi',         zone: 'Asia/Karachi' },
  { city: 'Tashkent',        zone: 'Asia/Tashkent' },
  { city: 'Mumbai',          zone: 'Asia/Kolkata' },
  { city: 'Delhi',           zone: 'Asia/Kolkata' },
  { city: 'Bengaluru',       zone: 'Asia/Kolkata' },
  { city: 'Chennai',         zone: 'Asia/Kolkata' },
  { city: 'Kathmandu',       zone: 'Asia/Kathmandu' },
  { city: 'Dhaka',           zone: 'Asia/Dhaka' },
  { city: 'Colombo',         zone: 'Asia/Colombo' },
  { city: 'Yangon',          zone: 'Asia/Yangon' },
  { city: 'Bangkok',         zone: 'Asia/Bangkok' },
  { city: 'Hanoi',           zone: 'Asia/Bangkok' },
  { city: 'Jakarta',         zone: 'Asia/Jakarta' },
  { city: 'Ho Chi Minh City', zone: 'Asia/Ho_Chi_Minh' },
  { city: 'Singapore',       zone: 'Asia/Singapore' },
  { city: 'Kuala Lumpur',    zone: 'Asia/Kuala_Lumpur' },
  { city: 'Hong Kong',       zone: 'Asia/Hong_Kong' },
  { city: 'Shanghai',        zone: 'Asia/Shanghai' },
  { city: 'Beijing',         zone: 'Asia/Shanghai' },
  { city: 'Shenzhen',        zone: 'Asia/Shanghai' },
  { city: 'Taipei',          zone: 'Asia/Taipei' },
  { city: 'Manila',          zone: 'Asia/Manila' },
  { city: 'Perth',           zone: 'Australia/Perth' },
  { city: 'Seoul',           zone: 'Asia/Seoul' },
  { city: 'Tokyo',           zone: 'Asia/Tokyo' },
  { city: 'Osaka',           zone: 'Asia/Tokyo' },
  { city: 'Adelaide',        zone: 'Australia/Adelaide' },
  { city: 'Brisbane',        zone: 'Australia/Brisbane' },
  { city: 'Sydney',          zone: 'Australia/Sydney' },
  { city: 'Melbourne',       zone: 'Australia/Melbourne' },
  { city: 'Auckland',        zone: 'Pacific/Auckland' },
  { city: 'Suva',            zone: 'Pacific/Fiji' },
];

// The offset as it stands right now, e.g. "+8", "-5", "+5:45".
//
// U+2212 MINUS SIGN rather than a hyphen: it is the character that lines up
// with "+" at the same width, so a column of offsets does not look ragged.
// zoneFromLabel normalises it back, so a pasted or hand-typed hyphen still
// resolves.
export function offsetLabel(zone, at = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(at);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (!name) return null;
    if (name === 'GMT') return '+0';
    return name.replace('GMT', '').replace('-', '−');
  } catch {
    return null;
  }
}

// "Dallas (UTC -5)". An entry may carry its own label — UTC does, because
// "UTC (UTC +0)" says the same thing twice.
export function cityLabel(entry, at = new Date()) {
  if (entry.label) return entry.label;
  const offset = offsetLabel(entry.zone, at);
  return offset ? `${entry.city} (UTC ${offset})` : entry.city;
}

const normalise = (value) => String(value ?? '')
  .trim().toLowerCase()
  .replace(/−/g, '-')      // minus sign back to a plain hyphen
  .replace(/\s+/g, ' ');

// A zone looks like "Area/Location" — or is bare "UTC". Used only to let a zone
// that has no city in the list survive a round trip through the form; anything
// that gets through here is still validated properly by the API.
const looksLikeZone = (value) => value === 'UTC' || /^[A-Za-z_]+\/[A-Za-z_+\-0-9/]+$/.test(value);

// What the box should say for a stored zone. Falls back to the raw IANA id
// rather than going blank: a zone with no city listed is unusual, but silently
// emptying the field would turn "unusual" into "about to be overwritten".
export function zoneCity(zone, at = new Date()) {
  const entry = TZ_CITIES.find((candidate) => candidate.zone === zone);
  return entry ? cityLabel(entry, at) : (zone || '');
}

// Typed text back to a zone, or null when it matches nothing.
//
// Three passes, loosest last: the whole label as the browser inserts it when a
// suggestion is picked; then the bare city, because someone who types "Dallas"
// and tabs away has been unambiguous; then a raw zone id, which is what a
// zone-without-a-city round-trips as.
export function zoneFromLabel(text, at = new Date()) {
  const query = normalise(text);
  if (!query) return null;

  for (const entry of TZ_CITIES) {
    if (normalise(cityLabel(entry, at)) === query) return entry.zone;
  }
  for (const entry of TZ_CITIES) {
    if (normalise(entry.city) === query) return entry.zone;
  }

  const raw = String(text).trim();
  return looksLikeZone(raw) ? raw : null;
}
