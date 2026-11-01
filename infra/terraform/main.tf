data "azurerm_client_config" "current" {}

locals {
  name = "genai-${var.environment}"
  tags = merge(var.tags, { app = "enterprise-genai-platform", environment = var.environment })

  # Services that run in the cluster and what each may touch. A service not listed in
  # `secret_readers` has no access to the vault at all.
  services = toset([
    "assistant",
    "llm-gateway",
    "prompt-registry",
    "ingestion",
    "retrieval",
    "agents",
    "mcp-gateway",
  ])
  secret_readers = toset(["assistant", "llm-gateway", "ingestion", "agents", "mcp-gateway"])
}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.name}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "secondary" {
  name     = "rg-${local.name}-secondary"
  location = var.secondary_location
  tags     = local.tags
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

# Images live in a registry only the cluster's kubelet can pull from; there is no admin user.
resource "azurerm_container_registry" "main" {
  name                          = replace("acr${local.name}", "-", "")
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  sku                           = "Standard"
  admin_enabled                 = false
  anonymous_pull_enabled        = false
  public_network_access_enabled = true
  tags                          = local.tags
}

resource "azurerm_role_assignment" "kubelet_acr_pull" {
  scope                            = azurerm_container_registry.main.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_kubernetes_cluster.main.kubelet_identity[0].object_id
  skip_service_principal_aad_check = true
}

# Every secret the platform reads (Entra client secrets, Azure OpenAI keys). RBAC, not access
# policies, so access is granted per identity and per role, and can be audited in one place.
resource "azurerm_key_vault" "main" {
  name                          = substr(replace("kv-${local.name}", "-", ""), 0, 24)
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  soft_delete_retention_days    = 90
  purge_protection_enabled      = true
  public_network_access_enabled = true
  tags                          = local.tags
}

resource "azurerm_monitor_diagnostic_setting" "key_vault" {
  name                       = "audit"
  target_resource_id         = azurerm_key_vault.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "AuditEvent"
  }
}
