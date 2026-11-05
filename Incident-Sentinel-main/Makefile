.PHONY: help start demo test trigger-incident recover clean

help:
	@echo "Incident-Sentinel - Autonomous SRE Incident Response Room on Switch"
	@echo "Commands:"
	@echo "  make start            - Start infrastructure simulator & MCP tool server"
	@echo "  make trigger-incident - Induce simulated 500 error spike on cart-service"
	@echo "  make test             - Run automated end-to-end incident recovery test"
	@echo "  make demo             - Run complete automated demo simulation"

start:
	python3 mock_infrastructure.py

trigger-incident:
	curl -X POST http://127.0.0.1:8090/trigger-incident

recover:
	curl -X POST http://127.0.0.1:8090/rollback -H "Content-Type: application/json" \
	-d '{"service":"cart-service","target_version":"v2.13.2","approved_by":"on-call-sre"}'

test:
	python3 test_incident_flow.py

demo:
	python3 test_incident_flow.py
