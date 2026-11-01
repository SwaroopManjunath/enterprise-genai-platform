# Two accounts in two regions: the gateway retries the primary and then falls back to the second.
# Keys are NOT copied into Key Vault by Terraform, which would put them in the state file; an
# operator stores them once (see README) and the gateway reads them by name.
resource "azurerm_cognitive_account" "primary" {
  name                          = "oai-${local.name}-primary"
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  kind                          = "OpenAI"
  sku_name                      = "S0"
  custom_subdomain_name         = "oai-${local.name}-primary"
  public_network_access_enabled = true
  tags                          = local.tags
}

resource "azurerm_cognitive_account" "secondary" {
  name                          = "oai-${local.name}-secondary"
  location                      = azurerm_resource_group.secondary.location
  resource_group_name           = azurerm_resource_group.secondary.name
  kind                          = "OpenAI"
  sku_name                      = "S0"
  custom_subdomain_name         = "oai-${local.name}-secondary"
  public_network_access_enabled = true
  tags                          = local.tags
}

resource "azurerm_cognitive_deployment" "chat" {
  for_each             = { primary = azurerm_cognitive_account.primary, secondary = azurerm_cognitive_account.secondary }
  name                 = "chat"
  cognitive_account_id = each.value.id

  model {
    format  = "OpenAI"
    name    = var.openai_model.name
    version = var.openai_model.version
  }

  sku {
    name     = "Standard"
    capacity = var.openai_capacity_k_tpm
  }
}
