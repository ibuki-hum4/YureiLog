param()
Write-Host "Running tests via Node script..."
node ./scripts/run-tests.js
if ($LASTEXITCODE -ne 0) { Write-Error "Tests failed"; exit $LASTEXITCODE }
Write-Host "Tests completed"; exit 0
