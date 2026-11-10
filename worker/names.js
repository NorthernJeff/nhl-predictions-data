// Display-name rules: letters, numbers, spaces and . - _ ' only; no web links, emails or phone numbers; no swearing or slurs.
const NAME_BAD_ANY=["fuck","fuk","fck","fvck","phuck","fuq","shit","cunt","bitch","whore","slut","nigg","nigga","faggot","retard","rape","porn","pussy","bastard","wank","twat","jizz","cum","dildo","motherf","asshole","dumbass","jackass","nazi","hitler"];
const NAME_BAD_WORD=["ass","arse","fag","dick","cock","tit","tits","piss","hoe","spic","kike","chink","coon","tranny","sex","nude","nudes","kys","damn","crap","prick","dyke","homo","penis","vagina","boob","boobs"];
function nameProblem(n){
  n=String(n||"").trim().replace(/\s+/g," ");
  if(n.length<2||n.length>24)return"Your display name must be 2 to 24 characters.";
  if(!/^[\p{L}\p{N} .'_-]+$/u.test(n))return"Please use only letters, numbers, spaces and . - _ ' in your name.";
  if((n.match(/\p{N}/gu)||[]).length>4)return"Please use no more than 4 numbers in your name.";
  if(/\b(www|https?)\b/i.test(n)||/\.\s*(com|ca|net|org|io|co|ly|me|gg|tv|xyz|info|biz|app|link|site|us|uk)\b/i.test(n))return"Web addresses aren't allowed in names.";
  const leet=s=>s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/0/g,"o").replace(/1/g,"i").replace(/3/g,"e").replace(/4/g,"a").replace(/5/g,"s").replace(/7/g,"t").replace(/8/g,"b");
  const flat=leet(n).replace(/[^a-z]/g,""),words=leet(n).split(/[^a-z]+/).filter(Boolean);
  const clean=flat.replace(/scunthorpe|cumming|cumberland|cucumber|document|circumstance|shitake|therapist|grape|drape|scrape/g,"");
  if(NAME_BAD_ANY.some(w=>clean.includes(w)))return"Please choose a different name.";
  if(words.some(w=>NAME_BAD_WORD.includes(w)))return"Please choose a different name.";
  return"";
}

export { nameProblem };
