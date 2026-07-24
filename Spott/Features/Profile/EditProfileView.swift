import PhotosUI
import SwiftUI
import UIKit

struct EditProfileView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var profile: UserProfile?
    @State private var loadError: UserFacingError?
    @State private var nickname = ""
    @State private var bio = ""
    @State private var region = "tokyo"
    @State private var saving = false
    @State private var error: UserFacingError?
    @State private var avatarItem: PhotosPickerItem?
    @State private var avatarPreview: UIImage?
    @State private var avatarUploading = false

    var body: some View {
        Form {
            Section("头像") {
                HStack(spacing: 16) {
                    Group {
                        if let avatarPreview {
                            Image(uiImage: avatarPreview).resizable().scaledToFill()
                        } else if let avatarURL = profile?.avatarURL {
                            AsyncImage(url: avatarURL) { image in
                                image.resizable().scaledToFill()
                            } placeholder: {
                                ProgressView()
                            }
                        } else {
                            Image(systemName: "person.crop.circle.fill")
                                .resizable()
                                .foregroundStyle(SpottColor.divider)
                        }
                    }
                    .frame(width: 72, height: 72)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(SpottColor.divider))

                    PhotosPicker(selection: $avatarItem, matching: .images) {
                        Label("更换头像", systemImage: "photo")
                    }
                    .disabled(avatarUploading)
                    if avatarUploading { ProgressView() }
                }
                Text("图片会先完成病毒扫描与内容安全处理，再替换当前头像。")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
            Section("公开资料") {
                TextField("昵称", text: $nickname)
                TextField("简介", text: $bio, axis: .vertical).lineLimit(3...8)
                Picker("常驻地区", selection: $region) { Text("东京").tag("tokyo"); Text("神奈川").tag("kanagawa"); Text("大阪").tag("osaka"); Text("京都").tag("kyoto") }
            }
            Section { Text("手机号、生日和安全记录永远不会显示在公开主页。") }
            if let loadError {
                Section {
                    Label {
                        Text("\(text("profile.edit.load_failed"))（\(loadError.id)）")
                    } icon: {
                        Image(systemName: "wifi.exclamationmark")
                    }
                    .foregroundStyle(SpottColor.danger)
                    Button(text("profile.edit.reload")) { Task { await load() } }
                }
            }
            if let error { Section { Text("\(error.message)（\(error.id)）").foregroundStyle(SpottColor.danger) } }
        }
        .navigationTitle("编辑资料")
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("保存") { save() }.disabled(profile == nil || nickname.isEmpty || saving) } }
        .onChange(of: avatarItem) { _, item in
            guard let item else { return }
            Task { await uploadAvatar(item) }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            let loaded = try await model.api.profile()
            profile = loaded; nickname = loaded.nickname; bio = loaded.bio; region = loaded.regionId ?? "tokyo"
            loadError = nil
        } catch {
            // Honest failure: surface the load error with a retry instead of a
            // silently empty form whose Save button never enables.
            loadError = AppModel.map(error)
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        ProfileTabLocalization.text(key, locale: locale)
    }

    private func uploadAvatar(_ item: PhotosPickerItem) async {
        avatarUploading = true
        defer { avatarUploading = false }
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data),
                  let jpeg = image.jpegData(compressionQuality: 0.86)
            else {
                throw APIError(
                    status: 0,
                    code: "IMAGE_INVALID",
                    message: text("profile.edit.image_unreadable"),
                    retryable: false
                )
            }
            _ = try await model.api.uploadProfileAvatar(
                data: jpeg,
                filename: "profile-avatar.jpg",
                mimeType: "image/jpeg"
            )
            avatarPreview = image
            profile = try await model.api.profile()
            error = nil
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func save() {
        guard let profile else { return }
        saving = true
        Task {
            do { _ = try await model.api.updateProfile(profile, nickname: nickname, bio: bio, regionID: region); dismiss() }
            catch {
                self.error = AppModel.map(error)
                // On a version conflict the stored If-Match is stale forever;
                // refetch so the next retry sends the fresh version while the
                // user's edits stay in the form fields.
                if (error as? APIError)?.code == "VERSION_CONFLICT",
                   let fresh = try? await model.api.profile() {
                    self.profile = fresh
                }
            }
            saving = false
        }
    }
}
