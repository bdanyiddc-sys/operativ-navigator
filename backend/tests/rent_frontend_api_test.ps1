# Rent Frontend API integration test (backend + API flow)
$ErrorActionPreference = 'Stop'
$Base = 'http://localhost:3000'
$Pass = 0; $Fail = 0
$RentId = $null

function Assert($cond, $name) {
  if ($cond) { Write-Host "PASS: $name" -ForegroundColor Green; $script:Pass++ }
  else { Write-Host "FAIL: $name" -ForegroundColor Red; $script:Fail++ }
}

Write-Host '=== Rent Frontend API integration test ===' -ForegroundColor Cyan

$urls = @('/', '/public/', '/driver/', '/admin', '/rent/public', '/rent/admin', '/api/config', '/api/admin/bookings', '/api/rent/inquiries')
foreach ($u in $urls) {
  try {
    $r = Invoke-WebRequest -Uri ($Base + $u) -UseBasicParsing -TimeoutSec 15
    Assert ($r.StatusCode -eq 200) "GET $u"
  } catch { Assert $false "GET $u" }
}

# Verify public.html no longer calls addPublicInquiry in saveProjectInquiry
$pub = Get-Content 'D:\cursor\operativ-navigator\frontend\rent\public.html' -Raw
Assert ($pub -match '/api/rent/inquiries') 'public.html uses /api/rent/inquiries'
Assert ($pub -notmatch 'addPublicInquiry') 'public.html no addPublicInquiry'

# Verify admin uses loadRentInquiriesFromApi
$adm = Get-Content 'D:\cursor\operativ-navigator\frontend\rent\admin.html' -Raw
Assert ($adm -match 'loadRentInquiriesFromApi') 'admin.html loadRentInquiriesFromApi'
Assert ($adm -notmatch 'seedDemoIfEmpty\(\)') 'admin boot no seedDemoIfEmpty call'

# POST FRONTEND API TESZT (simulates public form submission)
$futureDate = (Get-Date).AddDays(30).ToString('yyyy-MM-dd')
$postJson = @"
{
  "name": "FRONTEND API TESZT",
  "ordererName": "FRONTEND API TESZT",
  "phone": "+36301112222",
  "email": "frontend.api.teszt@example.hu",
  "city": "Tata",
  "street": "Váralja utca",
  "houseNumber": "1",
  "date": "$futureDate",
  "timeStart": "10:00",
  "timeEnd": "13:00",
  "headcount": 17,
  "bookingType": "BERLES",
  "booking_type": "custom_route",
  "status": "ARAJANLATKERES",
  "source": "frontend_api_test",
  "routePoints": [
    { "lat": 47.6501, "lng": 18.3182 },
    { "lat": 47.6510, "lng": 18.3200 },
    { "lat": 47.6520, "lng": 18.3220 }
  ],
  "routeGeometry": {
    "type": "LineString",
    "coordinates": [
      [18.3182, 47.6501],
      [18.3200, 47.6510],
      [18.3220, 47.6520]
    ]
  }
}
"@
$postResp = Invoke-WebRequest -Uri ($Base + '/api/rent/inquiries') -Method Post -Body $postJson -ContentType 'application/json; charset=utf-8' -UseBasicParsing
$postData = $postResp.Content | ConvertFrom-Json
$RentId = $postData.inquiry.id
Assert ($postResp.StatusCode -eq 201) 'POST FRONTEND API TESZT 201'
Assert ($RentId -match '^RENT-') 'POST RENT id'

$list = Invoke-RestMethod ($Base + '/api/rent/inquiries')
Assert (($list.inquiries | Where-Object { $_.id -eq $RentId }).Count -eq 1) 'GET list contains record'

$get1 = Invoke-RestMethod ($Base + '/api/rent/inquiries/' + $RentId)
Assert ($get1.inquiry.name -eq 'FRONTEND API TESZT') 'GET name'
Assert (@($get1.inquiry.routePoints).Count -ge 3) 'GET routePoints'
Assert ($get1.inquiry.routeGeometry.type -eq 'LineString') 'GET routeGeometry'

# PATCH (admin save simulation)
$patchBody = '{"status":"MEGRENDELVE","vehicle":"KV01","driver":"ZF","note":"FRONTEND PATCH TESZT"}'
$patchResp = Invoke-WebRequest -Uri ($Base + '/api/rent/inquiries/' + $RentId) -Method Patch -Body $patchBody -ContentType 'application/json; charset=utf-8' -UseBasicParsing
$get2 = Invoke-RestMethod ($Base + '/api/rent/inquiries/' + $RentId)
Assert ($get2.inquiry.status -eq 'MEGRENDELVE') 'PATCH status'
Assert ($get2.inquiry.vehicle -eq 'KV01') 'PATCH vehicle'
Assert ($get2.inquiry.note -eq 'FRONTEND PATCH TESZT') 'PATCH note'
Assert (@($get2.inquiry.routePoints).Count -ge 3) 'PATCH routePoints preserved'

# adminCalculatedRoute PATCH
$calcRoute = @{
  bookingId = $RentId
  distanceKm = 12.5
  travelMinutes = 18
  geometry = @{ type = 'LineString'; coordinates = @(@(18.32,47.65),@(18.33,47.66)) }
  calculatedAt = (Get-Date).ToString('o')
}
$calcJson = (@{ adminCalculatedRoute = $calcRoute } | ConvertTo-Json -Depth 8 -Compress)
Invoke-WebRequest -Uri ($Base + '/api/rent/inquiries/' + $RentId) -Method Patch -Body $calcJson -ContentType 'application/json; charset=utf-8' -UseBasicParsing | Out-Null
$get3 = Invoke-RestMethod ($Base + '/api/rent/inquiries/' + $RentId)
Assert ($get3.inquiry.adminCalculatedRoute.distanceKm -eq 12.5) 'adminCalculatedRoute saved'
Assert (@($get3.inquiry.routePoints).Count -ge 3) 'adminCalculatedRoute routePoints preserved'

# SW check
$sw = Get-Content 'D:\cursor\operativ-navigator\frontend\rent\sw.js' -Raw
Assert ($sw -match 'opnav-rent-v2') 'sw cache v2'
Assert ($sw -match "/api/") 'sw api bypass'

Write-Host ""
Write-Host "FRONTEND TEST RENT ID: $RentId"
Write-Host "PASS=$Pass FAIL=$Fail"
if ($Fail -gt 0) { exit 1 }
