resource "azurerm_kubernetes_cluster" "main" {
  name                = "aks-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  dns_prefix          = local.name
  sku_tier            = "Standard"
  tags                = local.tags

  # Sign-in is Entra ID only, and Kubernetes permissions are Azure role assignments.
  local_account_disabled = true
  azure_active_directory_role_based_access_control {
    azure_rbac_enabled     = true
    admin_group_object_ids = var.aks_admin_group_object_ids
  }

  # Pods get an Azure identity from a federated credential (see identity.tf), not from a stored secret.
  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  automatic_upgrade_channel = "patch"
  node_os_upgrade_channel   = "NodeImage"

  api_server_access_profile {
    authorized_ip_ranges = var.api_server_authorized_ip_ranges
  }

  identity {
    type = "SystemAssigned"
  }

  default_node_pool {
    name                         = "system"
    vm_size                      = var.node_vm_size
    zones                        = ["1", "2", "3"]
    auto_scaling_enabled         = true
    min_count                    = var.system_node_count_min
    max_count                    = var.system_node_count_max
    only_critical_addons_enabled = true
    upgrade_settings {
      max_surge = "33%"
    }
  }

  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    network_policy      = "cilium"
    network_data_plane  = "cilium"
    load_balancer_sku   = "standard"
  }

  # Mounts Key Vault secrets into pods (and syncs them to Kubernetes secrets) with the pod's own identity.
  key_vault_secrets_provider {
    secret_rotation_enabled  = true
    secret_rotation_interval = "5m"
  }

  oms_agent {
    log_analytics_workspace_id      = azurerm_log_analytics_workspace.main.id
    msi_auth_for_monitoring_enabled = true
  }

  azure_policy_enabled = true
}

# Application pods run here, so the system pool stays for cluster add-ons only.
resource "azurerm_kubernetes_cluster_node_pool" "workload" {
  name                  = "workload"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.main.id
  vm_size               = var.node_vm_size
  zones                 = ["1", "2", "3"]
  auto_scaling_enabled  = true
  min_count             = var.workload_node_count_min
  max_count             = var.workload_node_count_max
  mode                  = "User"
  tags                  = local.tags
  upgrade_settings {
    max_surge = "33%"
  }
}
