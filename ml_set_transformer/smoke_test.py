"""Quick smoke test: 2 epochs, batch_size 16, validate pipeline executes end-to-end without error."""
import sys, os, importlib.util
sys.path.insert(0, str(os.path.dirname(__file__)))
# Monkey-patch EPOCHS to 2 by editing module before load
import types
spec = importlib.util.spec_from_file_location('rp', os.path.join(os.path.dirname(__file__), 'run_pipeline.py'))
mod = importlib.util.module_from_spec(spec)
# Inject overrides via env vars before exec
os.environ['SMOKE_EPOCHS'] = '2'
# We'll just re-edit run_pipeline temporarily — quicker: just load and run with override
print('Smoke test: this is a placeholder. Use --smoke argv flag instead.')
