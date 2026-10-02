-- Add a bounded integer TTL to canonical CLR UTC timestamps without the
-- bundled NLua DateTime instance-method binder or the host's local timezone.
return function(captured,ttlMs)
  assert(type(captured)=='string'and type(ttlMs)=='number'and ttlMs%1==0 and ttlMs>=1 and ttlMs<=30000,'Native UTC expiry bounds')
  local y,m,d,h,n,s,f=captured:match('^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)%.(%d%d%d%d%d%d%d)Z$')
  assert(y,'Native canonical UTC required')
  y,m,d,h,n,s,f=tonumber(y),tonumber(m),tonumber(d),tonumber(h),tonumber(n),tonumber(s),tonumber(f)
  local function monthDays(year,month)
    if month==2 then return (year%4==0 and(year%100~=0 or year%400==0))and 29 or 28 end
    return ({31,28,31,30,31,30,31,31,30,31,30,31})[month]
  end
  assert(y>=1 and y<=9999 and m>=1 and m<=12 and d>=1 and d<=monthDays(y,m)and h<24 and n<60 and s<60,'Native UTC calendar bounds')
  f=f+ttlMs*10000;s=s+f//10000000;f=f%10000000
  n=n+s//60;s=s%60;h=h+n//60;n=n%60;d=d+h//24;h=h%24
  if d>monthDays(y,m)then d=d-monthDays(y,m);m=m+1;if m==13 then m=1;y=y+1 end end
  assert(y<=9999,'Native UTC calendar overflow')
  return string.format('%04d-%02d-%02dT%02d:%02d:%02d.%07dZ',y,m,d,h,n,s,f)
end
