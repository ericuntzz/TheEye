#!/bin/bash
# =============================================================================
# Atria — End-to-End API Integration Tests
# Tests every endpoint: happy path, error paths, edge cases, auth boundaries
# =============================================================================

BASE="${BASE_URL:-http://localhost:3000}"
TOKEN="$1"

if [ -z "$TOKEN" ]; then
  echo "Usage: ./test-api.sh <auth_token>"
  exit 1
fi

PASS=0
FAIL=0

test_endpoint() {
  local name="$1"
  local expected_status="$2"
  local method="$3"
  local path="$4"
  local body="$5"
  local auth="${6:-yes}"

  local url="$BASE$path"
  local status=""
  local body_resp=""

  if [ "$method" = "GET" ]; then
    if [ "$auth" = "yes" ]; then
      response=$(curl -s -o /tmp/test_body -w "%{http_code}" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" "$url")
    else
      response=$(curl -s -o /tmp/test_body -w "%{http_code}" -H "Content-Type: application/json" "$url")
    fi
  else
    if [ "$auth" = "yes" ]; then
      response=$(curl -s -o /tmp/test_body -w "%{http_code}" -X "$method" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "$body" "$url")
    else
      response=$(curl -s -o /tmp/test_body -w "%{http_code}" -X "$method" -H "Content-Type: application/json" -d "$body" "$url")
    fi
  fi

  status="$response"
  body_resp=$(cat /tmp/test_body 2>/dev/null)

  if [ "$status" = "$expected_status" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ $name (HTTP $status)"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $name — expected $expected_status, got $status"
    echo "     Response: $(echo "$body_resp" | head -c 200)"
  fi

  # Export body for chaining
  LAST_BODY="$body_resp"
}

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  ATRIA — API Integration Test Suite"
echo "════════════════════════════════════════════════════════════════"
echo ""

# ─────────────────────────────────────────────────────────────────
echo "1. HEALTH CHECK"
echo "─────────────────────────────────────────────────────────────"
test_endpoint "Health endpoint" "200" "GET" "/api/health" "" "no"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "2. AUTH BOUNDARIES"
echo "─────────────────────────────────────────────────────────────"
test_endpoint "Properties without auth → 401" "401" "GET" "/api/properties" "" "no"
test_endpoint "Inspections without auth → 401" "401" "GET" "/api/inspections" "" "no"
test_endpoint "Users/me without auth → 401" "401" "GET" "/api/users/me" "" "no"
test_endpoint "Compare without auth → 401" "401" "POST" "/api/vision/compare" '{"test":true}' "no"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "3. USER PROFILE"
echo "─────────────────────────────────────────────────────────────"
test_endpoint "Users/me with auth → 200" "200" "GET" "/api/users/me"
echo "     User: $(echo "$LAST_BODY" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("email","?"))' 2>/dev/null)"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "4. PROPERTIES — CRUD"
echo "─────────────────────────────────────────────────────────────"
test_endpoint "List properties → 200" "200" "GET" "/api/properties"
PROPERTY_COUNT=$(echo "$LAST_BODY" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))' 2>/dev/null)
echo "     Properties found: $PROPERTY_COUNT"

# Get first property ID
PROPERTY_ID=$(echo "$LAST_BODY" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[0]["id"] if d else "NONE")' 2>/dev/null)
echo "     First property ID: $PROPERTY_ID"

if [ "$PROPERTY_ID" != "NONE" ] && [ -n "$PROPERTY_ID" ]; then
  test_endpoint "Get property detail → 200" "200" "GET" "/api/properties/$PROPERTY_ID"
  test_endpoint "Get property rooms → 200" "200" "GET" "/api/properties/$PROPERTY_ID/rooms"

  ROOM_COUNT=$(echo "$LAST_BODY" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))' 2>/dev/null)
  echo "     Rooms found: $ROOM_COUNT"
fi

# ─────────────────────────────────────────────────────────────────
echo ""
echo "5. PROPERTIES — ERROR PATHS"
echo "─────────────────────────────────────────────────────────────"
test_endpoint "Get fake property → 404" "404" "GET" "/api/properties/00000000-0000-0000-0000-000000000000"
test_endpoint "Create property no name → 400" "400" "POST" "/api/properties" '{"address":"test"}'
test_endpoint "Create property empty → 400" "400" "POST" "/api/properties" '{}'
test_endpoint "Property malformed JSON → 400" "400" "POST" "/api/properties" 'not-json'

# ─────────────────────────────────────────────────────────────────
echo ""
echo "6. BASELINES & CONDITIONS"
echo "─────────────────────────────────────────────────────────────"
if [ "$PROPERTY_ID" != "NONE" ] && [ -n "$PROPERTY_ID" ]; then
  test_endpoint "List baselines → 200" "200" "GET" "/api/properties/$PROPERTY_ID/baselines"
  test_endpoint "List conditions → 200" "200" "GET" "/api/properties/$PROPERTY_ID/conditions"

  # Create a condition
  test_endpoint "Create condition → 201" "201" "POST" "/api/properties/$PROPERTY_ID/conditions" '{"description":"Test scratch on counter","category":"accepted_wear","severity":"cosmetic"}'
  CONDITION_ID=$(echo "$LAST_BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id","NONE"))' 2>/dev/null)
  echo "     Created condition: $CONDITION_ID"

  # Resolve the condition
  if [ "$CONDITION_ID" != "NONE" ] && [ -n "$CONDITION_ID" ]; then
    test_endpoint "Resolve condition → 200" "200" "PATCH" "/api/properties/$PROPERTY_ID/conditions" "{\"conditionId\":\"$CONDITION_ID\"}"
  fi
fi

# ─────────────────────────────────────────────────────────────────
echo ""
echo "7. INSPECTIONS — CREATE & READ"
echo "─────────────────────────────────────────────────────────────"
test_endpoint "List inspections → 200" "200" "GET" "/api/inspections"

if [ "$PROPERTY_ID" != "NONE" ] && [ -n "$PROPERTY_ID" ]; then
  # This will fail if property isn't trained
  test_endpoint "Create inspection (untrained) → 400" "400" "POST" "/api/inspections" "{\"propertyId\":\"$PROPERTY_ID\",\"inspectionMode\":\"turnover\"}"
fi

# Try with a fake property
test_endpoint "Inspection fake property → 404" "404" "POST" "/api/inspections" '{"propertyId":"00000000-0000-0000-0000-000000000000"}'
test_endpoint "Inspection no propertyId → 400" "400" "POST" "/api/inspections" '{}'
# Use a guaranteed-valid UUID for mode test (mode validation fires before property lookup)
test_endpoint "Inspection invalid mode → 400" "400" "POST" "/api/inspections" '{"propertyId":"00000000-0000-0000-0000-000000000000","inspectionMode":"invalid_mode"}'

# ─────────────────────────────────────────────────────────────────
echo ""
echo "8. INSPECTION ENDPOINTS — ERROR PATHS"
echo "─────────────────────────────────────────────────────────────"
FAKE_ID="00000000-0000-0000-0000-000000000000"
test_endpoint "Get fake inspection → 404" "404" "GET" "/api/inspections/$FAKE_ID"
test_endpoint "Bulk fake inspection → 404" "404" "POST" "/api/inspections/$FAKE_ID/bulk" '{"results":[{"roomId":"x","baselineImageId":"x","currentImageUrl":"x","score":90,"findings":[]}]}'
test_endpoint "Baselines fake inspection → 404" "404" "GET" "/api/inspections/$FAKE_ID/baselines"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "9. EMBEDDINGS API"
echo "─────────────────────────────────────────────────────────────"
test_endpoint "Embeddings no body → 400" "400" "POST" "/api/embeddings" '{}'
test_endpoint "Embeddings with imageUrls → 200" "200" "POST" "/api/embeddings" '{"imageUrls":["https://example.com/test.jpg"]}'
test_endpoint "Embeddings invalid imageIds → 400" "400" "POST" "/api/embeddings" '{"imageIds":["not-a-uuid"]}'
test_endpoint "Embeddings fake propertyId → 404" "404" "POST" "/api/embeddings" "{\"propertyId\":\"$FAKE_ID\"}"
test_endpoint "Embeddings without auth → 401" "401" "POST" "/api/embeddings" '{"imageUrls":["test"]}' "no"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "10. VISION COMPARE — ERROR PATHS"
echo "─────────────────────────────────────────────────────────────"
test_endpoint "Compare no body → 400" "400" "POST" "/api/vision/compare" '{}'
test_endpoint "Compare missing fields → 400" "400" "POST" "/api/vision/compare" '{"baseline_image_url":"test"}'

# ─────────────────────────────────────────────────────────────────
echo ""
echo "11. UPLOAD — ERROR PATHS"
echo "─────────────────────────────────────────────────────────────"
test_endpoint "Upload no body → 400" "400" "POST" "/api/upload" '{}'
test_endpoint "Upload missing propertyId → 400" "400" "POST" "/api/upload" '{"base64Image":"dGVzdA=="}'
test_endpoint "Upload fake property → 404" "404" "POST" "/api/upload" "{\"base64Image\":\"dGVzdA==\",\"propertyId\":\"$FAKE_ID\"}"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  RESULTS: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════════════════════════════"
echo ""

if [ $FAIL -gt 0 ]; then
  exit 1
fi
