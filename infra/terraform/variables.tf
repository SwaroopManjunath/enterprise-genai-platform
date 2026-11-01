variable "subscription_id" {
  type        = string
  description = "The Azure subscription to deploy into."
}

variable "environment" {
  type        = string
  description = "Short name of this environment, used in every resource name (for example dev, staging, prod)."
  validation {
    condition     = can(regex("^[a-z0-9]{2,8}$", var.environment))
    error_message = "environment must be 2-8 lowercase letters or digits."
  }
}

variable "location" {
  type        = string
  description = "Primary region."
  default     = "westeurope"
}

variable "secondary_location" {
  type        = string
  description = "Region of the fallback Azure OpenAI account: a different region, so one outage does not take out both."
  default     = "swedencentral"
}

variable "namespace" {
  type        = string
  description = "Kubernetes namespace the platform runs in. Federated credentials are bound to it."
  default     = "genai"
}

variable "aks_admin_group_object_ids" {
  type        = list(string)
  description = "Entra ID groups that administer the cluster. There are no local cluster accounts."
  validation {
    condition     = length(var.aks_admin_group_object_ids) > 0
    error_message = "Name at least one admin group: local accounts are disabled, so nobody could log in otherwise."
  }
}

variable "api_server_authorized_ip_ranges" {
  type        = list(string)
  description = "CIDR ranges allowed to reach the Kubernetes API. Empty means any address (authentication still applies)."
  default     = []
}

variable "system_node_count_min" {
  type    = number
  default = 3
}

variable "system_node_count_max" {
  type    = number
  default = 5
}

variable "workload_node_count_min" {
  type    = number
  default = 2
}

variable "workload_node_count_max" {
  type    = number
  default = 10
}

variable "node_vm_size" {
  type    = string
  default = "Standard_D4ds_v5"
}

variable "openai_model" {
  type = object({
    name    = string
    version = string
  })
  description = "The chat model deployed to both accounts."
  default = {
    name    = "gpt-4o"
    version = "2024-11-20"
  }
}

variable "openai_capacity_k_tpm" {
  type        = number
  description = "Tokens per minute for each deployment, in thousands."
  default     = 50
}

variable "tags" {
  type    = map(string)
  default = {}
}
