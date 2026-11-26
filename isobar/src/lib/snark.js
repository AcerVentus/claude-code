// The forecaster's voice. Four temperaments, one honest forecast: the line
// is picked from the measured conditions and never changes the numbers.

const LINES = {
  thunder: {
    straight: ['Thunderstorms in the area. Stay indoors while lightning is close.'],
    warm: ['Storms about. A good evening to stay in and count the seconds after each flash.'],
    dry: ['The sky is throwing things. Standing under the tallest tree remains a bad plan.', 'Free light show tonight. Admission is your sense of safety.'],
    feral: ['The atmosphere has chosen violence. You have chosen… a metal umbrella? Bold.', 'Lightning is nature\'s way of saying your plans were optional.'],
  },
  heavy_rain: {
    straight: ['Heavy rain. Allow extra time and watch for standing water.'],
    warm: ['Proper downpour out there. Waterproofs and patience.'],
    dry: ['It is raining with intent. Your umbrella will file a complaint.', 'The sky is emptying its pockets. All of them.'],
    feral: ['The clouds are having a breakdown and you are invited. Wear something you hate.', 'Rain so heavy the pavement is reconsidering its career.'],
  },
  rain: {
    straight: ['Rain. Take a waterproof layer.'],
    warm: ['A wet one. Jacket by the door, kettle on standby.'],
    dry: ['Rain. The sky has opinions and is sharing them at length.', 'Wet, with a chance of wetter.'],
    feral: ['It is raining, which means your one nice jacket is about to learn humility.', 'Moist. Deeply, personally moist.'],
  },
  snow: {
    straight: ['Snow. Roads and paths may be slippery.'],
    warm: ['Snow falling. Wrap up and walk like a penguin.'],
    dry: ['Snow. Lovely to look at, less lovely to commute through.', 'The world is being gently erased. Mind the ice.'],
    feral: ['Frozen sky dandruff, everywhere. Your car is now a rumour.', 'Snow: the weather that makes adults fall over in public.'],
  },
  very_hot: {
    straight: ['Extreme heat. Limit time outside, drink water, check on vulnerable people.'],
    warm: ['Dangerously hot. Shade, water and slow movements only.'],
    dry: ['The air has the temperament of a hair dryer. Hydrate like it is your job.', 'Outside is currently an oven with a view.'],
    feral: ['The sun is trying to reclaim you. Do not let it. Drink water, you beautiful raisin.', 'It is so hot the shade is asking for shade.'],
  },
  bitter: {
    straight: ['Severe cold. Cover exposed skin and limit time outdoors.'],
    warm: ['Bitterly cold. Every layer you own, then one more.'],
    dry: ['The air hurts. That is the forecast.', 'Cold enough to make you rethink your relationship with outside.'],
    feral: ['Your face will file for separation within minutes. Scarf up.', 'It is the kind of cold that has a personality, and it does not like you.'],
  },
  windy: {
    straight: ['Strong gusts. Secure loose objects and take care on exposed routes.'],
    warm: ['Blustery out. Hold on to your hat, and possibly your dog.'],
    dry: ['Windy. Your hairstyle has been reassigned.', 'The wind would like a word with anything not bolted down.'],
    feral: ['The wind is rearranging the neighbourhood without a permit.', 'Small dogs are now technically kites.'],
  },
  bad_air: {
    straight: ['Air quality is unhealthy. Reduce outdoor exertion.'],
    warm: ['The air is rough today. Take it easy outside, windows closed.'],
    dry: ['The air has texture today. That is not a feature.', 'Breathing is technically still free, just not recommended in bulk.'],
    feral: ['You can chew the air. Please do not chew the air.', 'Today\'s sky is brought to you by particulate matter.'],
  },
  hot: {
    straight: ['Hot. Keep hydrated and seek shade at midday.'],
    warm: ['A hot one. Water bottle, shade, and no heroics.'],
    dry: ['Hot. The pavement and your patience are both softening.', 'Warm enough that standing still counts as exercise.'],
    feral: ['You are being slow-roasted. Baste yourself in sunscreen.', 'The sun woke up and chose you specifically.'],
  },
  cold: {
    straight: ['Cold. Dress in layers.'],
    warm: ['Chilly. A proper coat day.'],
    dry: ['Cold. Your breath is now visible, which nobody asked for.', 'Coat weather, with gloves in a supporting role.'],
    feral: ['Your extremities have submitted their resignation.', 'Cold enough that your phone battery is also thinking about quitting.'],
  },
  fog: {
    straight: ['Fog. Visibility is reduced; drive with care.'],
    warm: ['Foggy. Everything looks like the start of a mystery novel.'],
    dry: ['Fog. The world has lowered its render distance.', 'Visibility: mostly vibes.'],
    feral: ['The clouds got lazy and are lying on the ground.', 'Somewhere in this fog is your destination. Good luck to you both.'],
  },
  humid: {
    straight: ['Very humid. It will feel warmer than the thermometer says.'],
    warm: ['Sticky out there. Loose clothes and cold drinks.'],
    dry: ['The air is wearing you like a damp towel.', 'Humid. You will arrive everywhere slightly glazed.'],
    feral: ['You are not sweating, you are marinating.', 'The air has the consistency of soup and none of the flavour.'],
  },
  uv: {
    straight: ['Very high UV. Sunscreen, hat and sunglasses.'],
    warm: ['Strong sun today. Sunscreen is your friend.'],
    dry: ['The sun is not messing about. SPF or regret.', 'UV is high enough to read your thoughts. Cover up.'],
    feral: ['The sun is trying to turn you into leather. Decline.', 'Apply sunscreen like you are frosting a cake you want to survive.'],
  },
  cloudy: {
    straight: ['Overcast and dry.'],
    warm: ['Grey but calm. A good day for getting things done.'],
    dry: ['Fifty shades of grey, none of them interesting.', 'The sky is buffering.'],
    feral: ['The sky is a ceiling tile today. Aspire accordingly.', 'Somebody left the lid on the planet.'],
  },
  partly: {
    straight: ['Partly cloudy and dry.'],
    warm: ['Sun and cloud taking turns. Pleasant enough.'],
    dry: ['Some cloud, some sky. Nobody is committing to anything.', 'A bit of everything, none of it dramatic.'],
    feral: ['The sky cannot make a decision and, frankly, neither can you.', 'Clouds are loitering. No arrests have been made.'],
  },
  clear_day: {
    straight: ['Clear skies.'],
    warm: ['A lovely clear day. Go outside if you can.'],
    dry: ['Suspiciously pleasant. Enjoy it before the weather notices.', 'Clear skies. No complaints, which is unsettling.'],
    feral: ['The weather is being nice. It wants something.', 'Sunshine with zero drama. Disgusting. Enjoy.'],
  },
  clear_night: {
    straight: ['Clear night.'],
    warm: ['A clear, calm night. Look up for a minute.'],
    dry: ['Clear night. The stars are out, judging quietly.', 'Nothing between you and the void but good weather.'],
    feral: ['The universe is fully visible and still not returning your calls.', 'Clear skies. The Moon can see what you are doing.'],
  },
};

export const PERSONALITIES = [
  { key: 'straight', label: 'Straight', hint: 'Just the facts' },
  { key: 'warm', label: 'Warm', hint: 'Friendly' },
  { key: 'dry', label: 'Dry', hint: 'Deadpan' },
  { key: 'feral', label: 'Feral', hint: 'Unfiltered' },
];

/** Which line family applies, most serious first. */
export function mood({ code, group, feels, gust, dew, aqi, uv, isDay }) {
  const n = (v) => typeof v === 'number' && Number.isFinite(v);
  if (group === 'thunder') return 'thunder';
  if (code === 'rain_heavy' || code === 'showers_heavy') return 'heavy_rain';
  if (group === 'snow' || group === 'sleet') return 'snow';
  if (n(feels) && feels >= 42) return 'very_hot';
  if (n(feels) && feels <= -15) return 'bitter';
  if (n(gust) && gust >= 60) return 'windy';
  if (group === 'rain') return 'rain';
  if (n(aqi) && aqi >= 151) return 'bad_air';
  if (n(feels) && feels >= 33) return 'hot';
  if (n(feels) && feels <= 2) return 'cold';
  if (group === 'fog') return 'fog';
  if (n(dew) && dew >= 23) return 'humid';
  if (isDay && n(uv) && uv >= 8) return 'uv';
  if (group === 'cloudy') return 'cloudy';
  if (group === 'partly') return 'partly';
  return isDay ? 'clear_day' : 'clear_night';
}

/** A line for the conditions; `seed` keeps it stable for the day instead of flickering on refresh. */
export function quip(conditions, personality = 'dry', seed = 0) {
  const family = LINES[mood(conditions)] || LINES.clear_day;
  const list = family[personality] || family.dry;
  return list[Math.abs(Math.floor(seed)) % list.length];
}
