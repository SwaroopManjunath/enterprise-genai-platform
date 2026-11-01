# One Azure identity per service, trusted only from that service's Kubernetes service account.
# A compromised pod can use its own identity and no other, and a service with no secrets has no
# access to the vault.
resource "azurerm_user_assigned_identity" "service" {
  for_each            = local.services
  name                = "id-${local.name}-${each.key}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "service" {
  for_each            = local.services
  name                = "aks-${each.key}"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = azurerm_user_assigned_identity.service[each.key].id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = azurerm_kubernetes_cluster.main.oidc_issuer_url
  subject             = "system:serviceaccount:${var.namespace}:${each.key}"
}

resource "azurerm_role_assignment" "secrets_user" {
  for_each             = local.secret_readers
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.service[each.key].principal_id
}
