output "resource_group" {
  value = azurerm_resource_group.main.name
}

output "aks_name" {
  value = azurerm_kubernetes_cluster.main.name
}

output "acr_login_server" {
  value = azurerm_container_registry.main.login_server
}

output "key_vault_name" {
  value = azurerm_key_vault.main.name
}

output "key_vault_uri" {
  value = azurerm_key_vault.main.vault_uri
}

output "tenant_id" {
  value = data.azurerm_client_config.current.tenant_id
}

# What the Helm chart needs for each service: the client id of its identity.
output "service_identity_client_ids" {
  value = { for name, id in azurerm_user_assigned_identity.service : name => id.client_id }
}

output "openai_endpoints" {
  value = {
    primary   = azurerm_cognitive_account.primary.endpoint
    secondary = azurerm_cognitive_account.secondary.endpoint
  }
}
