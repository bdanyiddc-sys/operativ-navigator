# Rent API smoke test – no external modules, read-only on project files except POST/PATCH test records
$ErrorActionPreference = 'Stop'
$Base = 'http://localhost:3000'
$Pass = 0
$Fail = 0
$RentId = $null

function Assert-True($cond, [string]$name) {
  $ok = [bool]$cond
  if ($ok) {
    Write-Host "PASS: $name" -ForegroundColor Green
    $script:Pass++
  } else {
    Write-Host "FAIL: $name" -ForegroundColor Red
    $script:Fail++
  }
}

function DigitsOnly([string]$s) {
  if ($null -eq $s) { return '' }
  return ($s -replace '\D', '')
}

Write-Host "=== Rent API smoke test ===" -ForegroundColor Cyan

$regression = @('/', '/public/', '/driver/', '/admin', '/rent/public', '/rent/admin', '/api/config', '/api/admin/bookings', '/api/rent/inquiries')
foreach ($path in $regression) {
  try {
    $r = Invoke-WebRequest -Uri ($Base + $path) -UseBasicParsing -TimeoutSec 15
    Assert-True ($r.StatusCode -eq 200) "GET $path -> 200"
  } catch {
    Assert-True $false "GET $path -> 200"
  }
}

$postJson = @'
{
  "name": "BACKEND PAYLOAD TESZT",
  "ordererName": "BACKEND PAYLOAD TESZT",
  "phone": "+36301234567",
  "email": "payload.teszt@example.hu",
  "city": "Tata",
  "street": "Váralja utca",
  "houseNumber": "1",
  "date": "2026-06-21",
  "timeStart": "09:00",
  "timeEnd": "12:30",
  "headcount": 31,
  "bookingType": "BERLES",
  "booking_type": "custom_route",
  "status": "ARAJANLATKERES",
  "source": "backend_payload_test",
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
  },
  "extraProbe": "MEGORZENDO_EXTRA",
  "customMeta": {
    "teszt": true,
    "verzio": "payload-v1",
    "bels\u0151Azonosito": "META-001"
  }
}
'@

$payload = $postJson | ConvertFrom-Json
$postResp = Invoke-WebRequest -Uri ($Base + '/api/rent/inquiries') -Method Post -Body $postJson -ContentType 'application/json; charset=utf-8' -UseBasicParsing
$postData = $postResp.Content | ConvertFrom-Json
$RentId = $postData.inquiry.id

Assert-True ($postResp.StatusCode -eq 201) 'POST status 201'
Assert-True ($postData.ok -eq $true) 'POST ok=true'
Assert-True ($RentId -match '^RENT-') 'POST id RENT- prefix'
Assert-True ($postData.inquiry.extraProbe -eq 'MEGORZENDO_EXTRA') 'POST response extraProbe'
Assert-True ($postData.inquiry.customMeta.teszt -eq $true) 'POST response customMeta.teszt'

$belsoKey = 'bels' + [char]0x0151 + 'Azonosito'

$get1 = Invoke-RestMethod -Uri ($Base + '/api/rent/inquiries/' + $RentId) -Method Get
Assert-True ($get1.ok -eq $true) 'GET one ok=true'
$expectedPhoneDigits = DigitsOnly ([string]$payload.phone)
Assert-True ((DigitsOnly ([string]$get1.inquiry.phone)) -eq $expectedPhoneDigits) 'GET phone digits match'
Assert-True (@($get1.inquiry.routePoints).Count -eq 3) 'GET routePoints count=3'
Assert-True ($get1.inquiry.routeGeometry.type -eq 'LineString') 'GET routeGeometry LineString'
Assert-True ($get1.inquiry.extraProbe -eq 'MEGORZENDO_EXTRA') 'GET extraProbe'
Assert-True ($get1.inquiry.customMeta.teszt -eq $true) 'GET customMeta.teszt'
Assert-True ($get1.inquiry.customMeta.verzio -eq 'payload-v1') 'GET customMeta.verzio'
Assert-True ($get1.inquiry.customMeta.$belsoKey -eq 'META-001') 'GET customMeta.belsoAzonosito'
Assert-True ($get1.inquiry.email -eq $payload.email) 'GET email'
Assert-True ($get1.inquiry.headcount -eq 31) 'GET headcount'
Assert-True ($get1.inquiry.booking_type -eq 'custom_route') 'GET booking_type'

$patchBody = '{"status":"MEGRENDELVE","vehicle":"KV01","driver":"ZF","note":"PATCH PAYLOAD MEGORZESI TESZT"}'
$patchResp = Invoke-WebRequest -Uri ($Base + '/api/rent/inquiries/' + $RentId) -Method Patch -Body $patchBody -ContentType 'application/json; charset=utf-8' -UseBasicParsing
$patchData = $patchResp.Content | ConvertFrom-Json
$get2 = Invoke-RestMethod -Uri ($Base + '/api/rent/inquiries/' + $RentId) -Method Get
$i = $get2.inquiry

Assert-True ($patchData.ok -eq $true) 'PATCH ok=true'
Assert-True ($i.status -eq 'MEGRENDELVE') 'PATCH status'
Assert-True ($i.vehicle -eq 'KV01') 'PATCH vehicle'
Assert-True ($i.driver -eq 'ZF') 'PATCH driver'
Assert-True ($i.note -eq 'PATCH PAYLOAD MEGORZESI TESZT') 'PATCH note'
Assert-True (@($i.routePoints).Count -eq 3) 'PATCH routePoints preserved'
Assert-True ($i.routeGeometry.type -eq 'LineString') 'PATCH routeGeometry preserved'
Assert-True ($i.extraProbe -eq 'MEGORZENDO_EXTRA') 'PATCH extraProbe preserved'
Assert-True ($i.customMeta.teszt -eq $true) 'PATCH customMeta.teszt preserved'
Assert-True ($i.customMeta.verzio -eq 'payload-v1') 'PATCH customMeta.verzio preserved'
Assert-True ($i.customMeta.$belsoKey -eq 'META-001') 'PATCH customMeta.belsoAzonosito preserved'
Assert-True ((DigitsOnly ([string]$i.phone)) -eq $expectedPhoneDigits) 'PATCH phone preserved'
Assert-True ($i.email -eq $payload.email) 'PATCH email preserved'
Assert-True ($i.name -eq $payload.name) 'PATCH name preserved'
Assert-True ($i.date -eq $payload.date) 'PATCH date preserved'
Assert-True ($i.headcount -eq 31) 'PATCH headcount preserved'

Write-Host ""
Write-Host "Created RENT ID: $RentId" -ForegroundColor Cyan
Write-Host "Results: PASS=$Pass FAIL=$Fail"
if ($Fail -gt 0) { exit 1 }
exit 0
